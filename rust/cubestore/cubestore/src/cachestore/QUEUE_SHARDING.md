# CubeStore Queue Throughput Optimization

## Executive Summary

CubeStore's pre-aggregation queue processes all operations (heartbeat, retrieve,
ack, add, cancel) through a **single OS thread**. Under multi-pod deployments,
this creates a linear increase in queue latency as pod count grows — manifesting
as 10-20s delays in pre-aggregation processing.

This document describes a two-stage optimization strategy:
- **Stage 1**: Sharded RW loop within a single CubeStore router (5-8x throughput)
- **Stage 2**: Multiple independent CubeStore routers with prefix-based partitioning (linear horizontal scale)

---

## Problem Statement

### Current Architecture

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Cube.js  │  │ Cube.js  │  │ Cube.js  │  │ Cube.js  │
│  Pod 1   │  │  Pod 2   │  │  Pod 3   │  │  Pod N   │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │              │              │              │
     │    WebSocket (1 conn per pod)              │
     │              │              │              │
     ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────┐
│              CubeStore Router                        │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │         Single RW Thread (bottleneck)         │  │
│  │                                               │  │
│  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐   │  │
│  │  │ HB  │→│ ACK │→│ RET │→│ ADD │→│ HB  │→… │  │
│  │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘   │  │
│  │                                               │  │
│  │  All ops queued sequentially. Each waits for  │  │
│  │  ALL preceding ops to complete before running │  │
│  └───────────────────────────────────────────────┘  │
│                         │                           │
│                         ▼                           │
│  ┌───────────────────────────────────────────────┐  │
│  │                 RocksDB                        │  │
│  │           (single WAL file)                    │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### The Queuing Problem

```
Time ──────────────────────────────────────────────────────────►

Pod 1:  [HEARTBEAT]─────────────────────────────────────► 50ms
Pod 2:         [RETRIEVE]─────────────────────────────────────► wait + 120ms
Pod 3:                [ACK]───────────────────────────────────────► wait + 50ms
Pod 4:                     [HEARTBEAT]────────────────────────────────► wait + 50ms
Pod 5:                          [RETRIEVE]────────────────────────────────► wait + 120ms
  ⋮                                  ⋮
Pod N:                                        [HEARTBEAT]─────────────────────► wait + 50ms
                                                                          ▲
                                                          Total latency = Σ(all preceding ops)
                                                          With 200 ops queued: ~10-20 seconds
```

**Key insight**: Operations on *different* queue items are completely independent.
A heartbeat for item A has zero data dependency on a retrieve for item B. Yet they
serialize because the single thread processes them sequentially.

---

## Stage 1: Sharded RW Loop

### Architecture

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Cube.js  │  │ Cube.js  │  │ Cube.js  │  │ Cube.js  │
│  Pod 1   │  │  Pod 2   │  │  Pod 3   │  │  Pod N   │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CubeStore Router                              │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Sharded RW Thread Pool (N shards)             │ │
│  │                                                            │ │
│  │   hash(item_key) % N → shard assignment                    │ │
│  │                                                            │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │ │
│  │  │ Shard 0  │  │ Shard 1  │  │ Shard 2  │  │ Shard N-1│  │ │
│  │  │          │  │          │  │          │  │          │  │ │
│  │  │ [HB-A]   │  │ [RET-B]  │  │ [ACK-C]  │  │ [HB-D]   │  │ │
│  │  │ [ACK-A]  │  │ [HB-B]   │  │ [ADD-E]  │  │ [RET-F]  │  │ │
│  │  │    ↓     │  │    ↓     │  │    ↓     │  │    ↓     │  │ │
│  │  │ execute  │  │ execute  │  │ execute  │  │ execute  │  │ │
│  │  │ in order │  │ in order │  │ in order │  │ in order │  │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │ │
│  └───────┼──────────────┼──────────────┼──────────────┼───────┘ │
│          │              │              │              │          │
│          ▼              ▼              ▼              ▼          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      RocksDB                              │   │
│  │          WAL (serialized writes, but fast)                │   │
│  │     Batch preparation happens in PARALLEL above           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Parallelism Achieved (Stage 1)

```
Time ──────────────────────────────────────────────────────────►

Shard 0:  [HB item-A]──► [ACK item-A]──►                    ~100ms total
Shard 1:  [RETRIEVE item-B]──────────────► [HB item-B]──►   ~170ms total
Shard 2:  [ACK item-C]──► [ADD item-E]──►                   ~100ms total
Shard 3:  [HB item-D]──► [RETRIEVE item-F]──────────────►   ~170ms total

          ├─────── All shards execute SIMULTANEOUSLY ───────┤

Total wall-clock time ≈ max(shard latencies) ≈ 170ms
     vs. sequential:  Σ(all ops) ≈ 540ms (3.2x improvement for 6 ops)
     at scale (200 ops, 8 shards): ~2.5s vs ~20s (8x improvement)
```

### Key Mechanisms

#### 1. Routing by Item Key

```
                    ┌────────────────┐
  queue_heartbeat   │                │
  key="tenant1/q1" │   hash(key)    │──→ shard = hash % N
                    │   % N shards   │
                    └───────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌────────┐   ┌────────┐   ┌────────┐
         │Shard 0 │   │Shard 1 │   │Shard 2 │
         │        │   │        │   │        │
         │ key    │   │ key    │   │ key    │
         │ "t1/q1"│   │ "t2/q5"│   │ "t1/q3"│
         │ "t3/q7"│   │ "t1/q2"│   │ "t2/q4"│
         └────────┘   └────────┘   └────────┘

  Same key → same shard (ordered)
  Different keys → may be different shards (parallel)
```

#### 2. Atomic Active Counters (O(1) Concurrency Check)

```
Before (scan RocksDB on every RETRIEVE):

  RETRIEVE("tenant1/q5", limit=3)
      │
      ▼
  ┌─────────────────────────────┐
  │ Scan ALL queue items where  │  ← O(n) per RETRIEVE
  │ prefix="tenant1" AND        │
  │ status=Active               │
  │ Count: 2                    │
  │ 2 < 3 → allow              │
  └─────────────────────────────┘
  Time: 5-50ms depending on queue size


After (atomic counter):

  RETRIEVE("tenant1/q5", limit=3)
      │
      ▼
  ┌─────────────────────────────┐
  │ counters["tenant1"]         │  ← O(1) atomic read
  │   .load() → 2              │
  │ 2 < 3 → CAS(2, 3) → allow │
  └─────────────────────────────┘
  Time: <1μs (nanoseconds)
```

#### 3. Per-Prefix Retrieve Locks

```
  Prefix "tenant1"                    Prefix "tenant2"
  ┌──────────────────┐               ┌──────────────────┐
  │  Mutex(tenant1)  │               │  Mutex(tenant2)  │
  │                  │               │                  │
  │  RETRIEVE q1 ───►│               │◄─── RETRIEVE q7  │
  │  RETRIEVE q2 ···▶│ (waits)       │◄··· RETRIEVE q8  │ (waits)
  │                  │               │                  │
  └──────────────────┘               └──────────────────┘
         │                                    │
         │         EXECUTE IN PARALLEL        │
         ▼                                    ▼

  Within same prefix: serialized (correctness)
  Across prefixes: fully parallel (performance)
```

#### 4. Direct Reads (Bypass RW Loop)

```
Before:                              After:

  READ request                       READ request
      │                                  │
      ▼                                  ▼
  ┌──────────┐                      ┌───────────────┐
  │ RW Queue │ ← blocked by writes  │ spawn_blocking│
  │ [WR][WR] │                      │               │
  │ [WR][RD] │ ← read waits here    │   RocksDB     │
  └──────────┘                      │   Snapshot    │ ← instant, lock-free
      │                             │   (read-only) │
      ▼                             └───────────────┘
  ~50-200ms wait                         ~1-5ms
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CUBESTORE_QUEUE_RW_WORKERS` | `1` | Number of sharded RW worker threads. `1` = upstream behavior. |

#### Resource Sizing

Each shard is a dedicated OS thread that can saturate one CPU core under load.

```
  CPU allocation formula:
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │  Total CPU = CUBESTORE_QUEUE_RW_WORKERS + 4         │
  │                                                     │
  │  The +4 accounts for:                               │
  │    • Tokio async runtime     (~2 cores)             │
  │    • RocksDB compaction      (~1 core)              │
  │    • Upload + metrics loops  (~1 core)              │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

| Scenario | Workers | CPU (cores) | Memory | Expected Throughput |
|----------|---------|-------------|--------|---------------------|
| Default / safe rollout | `1` | 4 | 2Gi | ~200 ops/sec (baseline) |
| Small (1-4 pods) | `4` | 8 | 2Gi | ~800 ops/sec |
| Medium (5-20 pods) | `8` | 12 | 4Gi | ~1,400 ops/sec |
| Large (20+ pods) | `12`–`16` | 16–20 | 4Gi | ~1,800-2,000 ops/sec |

### Latency Improvement (Stage 1)

```
  Queue latency vs. concurrent pods

  Latency
  (ms)
   │
20k│ ●
   │  ╲
   │   ╲  Before (single thread)
15k│    ╲
   │     ╲
   │      ╲
10k│       ╲
   │        ╲
   │         ╲
 5k│          ╲
   │           ╲
   │            ╲
 1k│─ ─ ─ ─ ─ ─ ╲─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
   │              ●━━━━━━━━━━━━━━━━━━━━━━━ After (8 shards)
   └──┬───┬───┬───┬───┬───┬───┬───┬───► Pods
      5  10  15  20  25  30  40  50

  Before: latency grows ~linearly with pod count
  After:  latency stays near-constant up to ~50 pods (8 shards)
```

### Scaling Limit (Stage 1)

```
  Throughput vs. shard count

  Ops/sec
   │
   │                          ┌──── WAL serialization ceiling
   │                          │
2.0k│              ●━━━━━━━━━━●━━━━━━━━●
   │          ●╱
   │        ●╱
1.5k│      ●╱
   │    ●╱
   │   ╱
1.0k│  ●
   │ ╱
   │╱
0.5k●
   │
   └──┬──┬──┬──┬──┬──┬──┬──┬──┬──► Shards
      1  2  4  6  8 10 12 14 16 20

  Linear improvement up to ~8-12 shards
  Diminishing returns 12-16 shards (WAL mutex contention)
  No benefit beyond ~16 shards
```

### Why Stage 1 Has a Ceiling

```
  Inside each shard thread:

  ┌──────────────────────────────────────────────────────────┐
  │ 1. Read item from RocksDB        ← parallel (snapshot)  │
  │ 2. Validate state / compute      ← parallel             │
  │ 3. Build WriteBatch              ← parallel             │
  │ 4. db.write(batch)               ← SERIALIZED (WAL)     │ ◄── bottleneck
  │ 5. Notify waiters                ← parallel             │
  └──────────────────────────────────────────────────────────┘

  Steps 1-3 and 5 run truly in parallel across all shards.
  Step 4 acquires a global mutex on the RocksDB WAL file.

  With 8 shards: step 4 is ~5% of total operation time → minimal contention
  With 16 shards: step 4 is ~15% → noticeable queueing on WAL mutex
  With 32 shards: step 4 is ~40% → threads spin-wait, wasting CPU
```

---

## Stage 2: Multiple CubeStore Routers

When Stage 1's ceiling is reached (~2,000 ops/sec, or 50+ highly active pods),
the next step is horizontal partitioning across multiple independent CubeStore
router instances.

### Architecture

```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ Cube.js  │ │ Cube.js  │ │ Cube.js  │ │ Cube.js  │ │ Cube.js  │ │ Cube.js  │
│  Pod 1   │ │  Pod 2   │ │  Pod 3   │ │  Pod 4   │ │  Pod 5   │ │  Pod N   │
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     │             │             │             │             │             │
     │             │             │             │             │             │
     ▼             ▼             ▼             ▼             ▼             ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                         Queue Router / Proxy                                   │
│                                                                                │
│    Route by: consistent_hash(tenant_prefix) → CubeStore instance              │
│                                                                                │
│    Prefix A-M → CubeStore 0                                                   │
│    Prefix N-Z → CubeStore 1                                                   │
│    (extensible to N partitions)                                                │
│                                                                                │
└──────────┬──────────────────────────────────────┬──────────────────────────────┘
           │                                      │
           ▼                                      ▼
┌─────────────────────────────┐    ┌─────────────────────────────┐
│      CubeStore Router 0     │    │      CubeStore Router 1     │
│                             │    │                             │
│  ┌───────────────────────┐  │    │  ┌───────────────────────┐  │
│  │ Sharded RW Pool (8)   │  │    │  │ Sharded RW Pool (8)   │  │
│  └───────────┬───────────┘  │    │  └───────────┬───────────┘  │
│              ▼              │    │              ▼              │
│  ┌───────────────────────┐  │    │  ┌───────────────────────┐  │
│  │     RocksDB 0         │  │    │  │     RocksDB 1         │  │
│  │  (prefixes A-M)       │  │    │  │  (prefixes N-Z)       │  │
│  └───────────────────────┘  │    │  └───────────────────────┘  │
└─────────────────────────────┘    └─────────────────────────────┘
```

### Why Prefix-Based Partitioning

```
  ┌─────────────────────────────────────────────────────────────┐
  │                   Partitioning Strategy                      │
  ├─────────────────────────────────────────────────────────────┤
  │                                                             │
  │  ✗ Round-robin partitioning:                                │
  │    • Items for same prefix spread across instances          │
  │    • Concurrency limit requires cross-instance coordination │
  │    • Distributed locking → complexity + latency             │
  │                                                             │
  │  ✓ Prefix-based (tenant) partitioning:                      │
  │    • All items for a prefix live on ONE instance            │
  │    • Concurrency limit is LOCAL (no coordination)           │
  │    • RETRIEVE correctness guaranteed by local state         │
  │    • Queue results always on same instance as the item      │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

### Scaling Characteristics (Stage 2)

```
  Throughput vs. CubeStore instances

  Ops/sec
   │
   │                                              ●  (4 instances × 2k each)
8k │                                           ╱
   │                                        ╱
   │                                     ╱
6k │                                  ●
   │                               ╱
   │                            ╱
4k │                         ●        ← LINEAR scaling
   │                      ╱              (no shared state)
   │                   ╱
2k │━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━  Stage 1 ceiling
   │            ╱
   │         ╱
   │      ●
   └──┬──┬──┬──┬──┬──┬──┬──┬──────► CubeStore instances
      1  2  3  4  5  6  7  8

  Each instance contributes ~2,000 ops/sec independently.
  No shared state → no coordination overhead → linear scaling.
```

### Routing Layer Options

```
Option A: Client-side routing (modify Cube.js orchestrator)
─────────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────┐
  │            Cube.js Orchestrator           │
  │                                          │
  │  route(query) {                          │
  │    prefix = extractTenantPrefix(query)   │
  │    instance = consistentHash(prefix)     │
  │              % numCubeStores             │
  │    return connections[instance]          │
  │  }                                       │
  └──────────────────────────────────────────┘

  Pro: No extra hop, lowest latency
  Con: Requires JS-side changes, all pods must know topology


Option B: Proxy-side routing (new component)
─────────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────┐
  │           CubeStore Proxy                │
  │         (thin WebSocket proxy)           │
  │                                          │
  │  • Parses queue operation prefix         │
  │  • Routes to correct backend             │
  │  • Handles backend failover             │
  │  • Transparent to Cube.js pods           │
  └──────────────────────────────────────────┘

  Pro: No Cube.js changes, centralized routing logic
  Con: Extra network hop (~1ms), new component to operate


Option C: Kubernetes Service + topology (simplest)
─────────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────┐
  │  Each Cube.js pod connects to a FIXED    │
  │  CubeStore instance via config:          │
  │                                          │
  │  Pod 1-10  → cubestore-0.svc            │
  │  Pod 11-20 → cubestore-1.svc            │
  │                                          │
  │  Orchestrator isolation ensures each     │
  │  pod only queries its own tenant prefix  │
  └──────────────────────────────────────────┘

  Pro: Zero code changes, just config + deployment
  Con: Uneven load if tenant sizes vary, manual rebalancing
```

### Queue Result Delivery

```
  Problem: Pod submits query on CubeStore-0, polls result from CubeStore-1

  ┌──────────┐        ┌─────────────┐        ┌─────────────┐
  │ Cube.js  │──ADD──►│ CubeStore-0 │        │ CubeStore-1 │
  │  Pod 1   │        │ (correct)   │        │             │
  │          │──POLL─►│             │        │             │
  │          │◄─RESULT│             │        │             │
  └──────────┘        └─────────────┘        └─────────────┘

  ✓ With prefix-based routing: Pod always hits same instance
    (because it always queries same tenant prefix)

  ✓ With Option C (fixed assignment): Pod always hits same instance
    (because connection is static)

  ✗ Only a problem with random/round-robin routing (don't do this)
```

---

## End-to-End Data Flow

### Before Optimization

```
  Cube.js Pod                    CubeStore Router
  ──────────                     ────────────────

  1. addToQueue(query)  ────────►  [queue: pos 47]
                                        │
                                        │ waits for 46 ops ahead
                                        ▼
  2. (10-20s later)              item processed
                                        │
  3. heartbeat()  ──────────────►  [queue: pos 12]
                                        │
                                        │ waits for 11 ops
                                        ▼
  4. retrieve()  ───────────────►  [queue: pos 31]
                                        │
                                        │ waits + scans active items (O(n))
                                        ▼
  5. (executes pre-agg)

  6. ack(result)  ──────────────►  [queue: pos 8]
                                        │
                                        ▼
  Total time: 10-20s queueing + actual computation
```

### After Stage 1

```
  Cube.js Pod                    CubeStore Router (8 shards)
  ──────────                     ───────────────────────────

  1. addToQueue(query)  ────────►  [shard 3: pos 2]
                                        │
                                        │ waits for 1 op (same-key only)
                                        ▼
  2. (~200ms later)              item processed
                                        │
  3. heartbeat()  ──────────────►  [shard 3: pos 0]
                                        │
                                        │ immediate (no queue)
                                        ▼
  4. retrieve()  ───────────────►  [atomic check: O(1)]
                                        │
                                        │ counter < limit → allow
                                        ▼
  5. (executes pre-agg)

  6. ack(result)  ──────────────►  [shard 3: pos 0]
                                        │
                                        │ immediate
                                        ▼
  Total time: <500ms queueing + actual computation
```

---

## Comparison Summary

```
┌─────────────────┬─────────────────────────┬─────────────────────────────────┐
│                 │       Stage 1           │         Stage 2                 │
│                 │   Sharded RW Loop       │   Multiple CubeStores           │
├─────────────────┼─────────────────────────┼─────────────────────────────────┤
│ Throughput      │ ~2,000 ops/sec          │ ~2,000 × N ops/sec              │
│ Latency (p99)   │ < 500ms (20 pods)       │ < 500ms (unlimited pods)       │
│ Complexity      │ Low (Rust-only change)  │ Medium (infra + routing)        │
│ Risk            │ Low (default=1, opt-in) │ Medium (new failure modes)      │
│ Code change     │ CubeStore only          │ CubeStore + JS or proxy         │
│ Scaling         │ Vertical (more CPU)     │ Horizontal (more instances)     │
│ Limit           │ WAL serialization       │ Network / operational overhead  │
│ Deploy effort   │ Env var change          │ New StatefulSet + routing       │
│ Rollback        │ Set workers=1           │ Remove instances + re-route     │
└─────────────────┴─────────────────────────┴─────────────────────────────────┘
```

---

## Deployment Roadmap

```
  Phase 1 (Now)                    Phase 2 (If needed)
  ─────────────                    ────────────────────

  ┌─────────────────────┐         ┌─────────────────────────────┐
  │ Set env var:        │         │ Deploy 2+ CubeStore routers │
  │ CUBESTORE_QUEUE_RW_ │         │ with prefix partitioning    │
  │ WORKERS=8           │         │                             │
  │                     │         │ Requires:                   │
  │ Increase CPU to 12  │         │ • Routing layer (Option C)  │
  │                     │         │ • StatefulSet for routers   │
  │ Monitor latency     │         │ • Rebalancing strategy      │
  │ for 1-2 weeks       │         │                             │
  └─────────┬───────────┘         └─────────────────────────────┘
            │                               ▲
            │   If p99 > 1s at scale        │
            └───────────────────────────────┘
```

---

## Correctness Guarantees

### Stage 1

| Property | Guarantee | Mechanism |
|----------|-----------|-----------|
| Per-item ordering | Operations on same item execute sequentially | Same routing key → same shard |
| Concurrency limit | Per-prefix active count never exceeds limit | Atomic CAS + per-prefix Mutex |
| No lost updates | Every write goes through WAL | RocksDB WriteBatch atomicity |
| Crash recovery | Counters rebuilt from RocksDB at startup | `rebuild_queue_active_counters()` |
| Backward compat | Default=1 shard = identical to upstream | Single thread = original code path |

### Stage 2

| Property | Guarantee | Mechanism |
|----------|-----------|-----------|
| Prefix isolation | All items for a prefix on one instance | Consistent hash routing |
| No split-brain | Routing is deterministic | Hash function is pure |
| Result delivery | Results always on same instance as item | Prefix routing ensures co-location |
| Failover | Instance loss = prefix unavailable until restart | Acceptable for pre-agg queue (retries) |

### No Dirty Reads

A "dirty read" occurs when a thread reads uncommitted or partially-written data
from another thread's in-progress transaction. This is **impossible** in the
sharded design due to three independent guarantees:

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                      WHY DIRTY READS CANNOT HAPPEN                          │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │                                                                             │
  │  1. SAME-KEY SERIALIZATION                                                  │
  │     ─────────────────────                                                   │
  │     All operations on the same item route to the same shard.                │
  │     Within a shard, operations execute one-at-a-time (FIFO channel).        │
  │                                                                             │
  │     Thread A (shard 3):  [WRITE item-X] ──► [READ item-X]                  │
  │                          ~~~~~~~~~~~         ~~~~~~~~~~                      │
  │                          completes first     sees committed state            │
  │                                                                             │
  │     ⇒ You can NEVER read item-X while a write to item-X is in-flight.      │
  │                                                                             │
  │  2. RocksDB WriteBatch ATOMICITY                                            │
  │     ────────────────────────────                                            │
  │     Every write operation builds a WriteBatch (multiple key-value pairs)    │
  │     and commits it atomically via db.write(batch).                          │
  │                                                                             │
  │     Shard 3:  batch = { set(item-X/status, Active),                         │
  │                         set(item-X/heartbeat, now()),                        │
  │                         set(seq, seq+1) }                                   │
  │               db.write(batch)  ← ALL or NOTHING, never partial              │
  │                                                                             │
  │     ⇒ Another thread cannot see status=Active but old heartbeat.            │
  │                                                                             │
  │  3. RocksDB SNAPSHOT ISOLATION for direct reads                             │
  │     ──────────────────────────────────────────                              │
  │     Read-only operations (queue_list, queue_get) use spawn_blocking          │
  │     with a RocksDB Snapshot. Snapshots see a frozen point-in-time view.     │
  │                                                                             │
  │     Timeline:                                                               │
  │                                                                             │
  │     Shard 3:     ──[BEGIN write item-X]──────[COMMIT]──►                    │
  │     Reader:         ──[create snapshot]──[read item-X]──►                   │
  │                       ▲                                                     │
  │                       │                                                     │
  │                       Snapshot taken BEFORE commit → sees OLD value          │
  │                       Snapshot taken AFTER commit  → sees NEW value          │
  │                       NEVER sees partial/in-progress state                   │
  │                                                                             │
  │     ⇒ Direct reads are immune to concurrent writes by design.               │
  │                                                                             │
  └─────────────────────────────────────────────────────────────────────────────┘
```

### No Side Effects Across Items

A "side effect" would be an operation on item A inadvertently modifying or
corrupting the state of item B. This is structurally impossible:

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                     WHY CROSS-ITEM SIDE EFFECTS ARE IMPOSSIBLE               │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │                                                                             │
  │  1. KEY-PREFIXED STORAGE                                                    │
  │     ────────────────────                                                    │
  │     Every queue item's data lives under its own key prefix in RocksDB:      │
  │                                                                             │
  │     RocksDB keyspace:                                                       │
  │     ┌──────────────────────────────────────────────────────┐                │
  │     │ queue_item:0x00010001  → { status, path, value, ... }│  ← item A     │
  │     │ queue_item:0x00010002  → { status, path, value, ... }│  ← item B     │
  │     │ queue_item:0x00010003  → { status, path, value, ... }│  ← item C     │
  │     └──────────────────────────────────────────────────────┘                │
  │                                                                             │
  │     A WriteBatch for item A ONLY touches keys prefixed with item A's ID.    │
  │     It is structurally impossible for it to overwrite item B's keys.        │
  │                                                                             │
  │  2. NO SHARED MUTABLE STATE BETWEEN SHARDS                                 │
  │     ──────────────────────────────────────────                              │
  │     Each shard closure captures only:                                       │
  │       • Arc<RocksDB> (thread-safe, read/write via atomic WAL)               │
  │       • Arc<QueueActiveCounters> (atomic integers, CAS-only)                │
  │                                                                             │
  │     There is NO shared Vec, HashMap, or mutable reference that one shard    │
  │     could corrupt for another.                                              │
  │                                                                             │
  │     Shard 0 ──► WriteBatch(item A) ──► RocksDB WAL ──┐                     │
  │     Shard 1 ──► WriteBatch(item B) ──► RocksDB WAL ──┤ serialized at WAL   │
  │     Shard 2 ──► WriteBatch(item C) ──► RocksDB WAL ──┘ but non-overlapping │
  │                                                                             │
  │     WAL serialization only orders WHEN batches persist — it does NOT        │
  │     allow one batch to read another's uncommitted data.                     │
  │                                                                             │
  │  3. ATOMIC COUNTERS USE CAS (no torn reads/writes)                          │
  │     ──────────────────────────────────────────────                          │
  │     The only shared cross-shard data structure is QueueActiveCounters:      │
  │                                                                             │
  │     try_increment(prefix, limit):                                           │
  │       loop {                                                                │
  │         current = counter.load(Acquire)    ← atomic 64-bit read             │
  │         if current >= limit { return Err }                                  │
  │         if counter.CAS(current, current+1, AcqRel) { return Ok }           │
  │       }                                                                     │
  │                                                                             │
  │     • CAS is a single CPU instruction (lock cmpxchg on x86)                │
  │     • No mutex → no deadlock, no priority inversion                         │
  │     • Torn reads impossible (AtomicUsize is always aligned)                 │
  │     • Worst case: CAS fails → retry loop (bounded by shard count)           │
  │                                                                             │
  │  4. PER-PREFIX MUTEX SCOPING                                                │
  │     ───────────────────────                                                 │
  │     The retrieve lock is per-prefix, stored in a DashMap:                   │
  │                                                                             │
  │     retrieve_locks: DashMap<String, Arc<Mutex<()>>>                         │
  │                                                                             │
  │     • Locking "tenant1" does NOT block "tenant2"                            │
  │     • A deadlock would require two prefixes to lock each other              │
  │       — impossible since each operation locks exactly ONE prefix             │
  │     • The lock scope is just the retrieve decision (check counter →         │
  │       update status → increment counter), not the entire operation          │
  │                                                                             │
  └─────────────────────────────────────────────────────────────────────────────┘
```

### Failure Mode Analysis

```
  ┌──────────────────────────┬─────────────────────┬───────────────────────────┐
  │ Scenario                 │ What happens        │ Recovery                  │
  ├──────────────────────────┼─────────────────────┼───────────────────────────┤
  │ Shard thread panics      │ Channel drops,      │ Callers get error,        │
  │                          │ other shards OK     │ restart CubeStore         │
  ├──────────────────────────┼─────────────────────┼───────────────────────────┤
  │ Counter drift            │ Counter says 5,     │ Detected at next          │
  │ (bug in decrement)       │ RocksDB says 4      │ startup via rebuild       │
  ├──────────────────────────┼─────────────────────┼───────────────────────────┤
  │ RocksDB write stall      │ All shards block    │ Compaction clears stall,  │
  │                          │ on db.write()       │ ops resume automatically  │
  ├──────────────────────────┼─────────────────────┼───────────────────────────┤
  │ CAS loop contention      │ Spin briefly on     │ Self-resolving (bounded   │
  │ (many shards, 1 prefix)  │ counter increment   │ by shard count)           │
  ├──────────────────────────┼─────────────────────┼───────────────────────────┤
  │ Process crash mid-write  │ WriteBatch not      │ RocksDB WAL replay on     │
  │                          │ committed → lost    │ restart; counter rebuild  │
  ├──────────────────────────┼─────────────────────┼───────────────────────────┤
  │ Read during compaction   │ Snapshot still      │ No action needed —        │
  │                          │ valid (immutable)   │ RocksDB guarantees this   │
  └──────────────────────────┴─────────────────────┴───────────────────────────┘
```

---

## Monitoring

### Stage 1 Metrics to Watch

```
  ┌────────────────────────────┬─────────────────────┐
  │ Healthy                    │ Action needed       │
  ├────────────────────────────┼─────────────────────┤
  │ p99 queue latency < 500ms  │ p99 > 2s → add     │
  │                            │ more shards         │
  ├────────────────────────────┼─────────────────────┤
  │ RocksDB write stalls = 0   │ stalls > 0 →       │
  │                            │ reduce shards       │
  ├────────────────────────────┼─────────────────────┤
  │ Channel utilization < 50%  │ > 80% → reduce     │
  │                            │ load or add shards  │
  ├────────────────────────────┼─────────────────────┤
  │ CPU utilization < 70%      │ > 90% → increase   │
  │                            │ CPU limit           │
  └────────────────────────────┴─────────────────────┘
```

### Key Log Messages

| Message | Severity | Action |
|---------|----------|--------|
| `Failed to schedule keyed task to ShardedRWLoop` | ERROR | Channel full — increase CPU or reduce shards |
| `Panic during sharded rw loop execution` | ERROR | Bug in operation logic — investigate |
| `Rebuilt queue active counters with N prefixes` | INFO | Normal startup — confirms counter sync |

---

## Appendix: Operation Classification

```
  ┌──────────────────────┬───────────────┬────────────────────────────────┐
  │ Operation            │ Type          │ Routing Strategy               │
  ├──────────────────────┼───────────────┼────────────────────────────────┤
  │ queue_add            │ Write         │ Sharded by item path           │
  │ queue_heartbeat      │ Write         │ Sharded by item key            │
  │ queue_retrieve       │ Read + Write  │ Per-prefix lock + shard write  │
  │ queue_ack            │ Write         │ Sharded by item key            │
  │ queue_cancel         │ Write         │ Sharded by item key            │
  │ queue_list           │ Read-only     │ Direct read (snapshot)         │
  │ queue_get            │ Read-only     │ Direct read (snapshot)         │
  │ queue_result         │ Read-only     │ Direct read (snapshot)         │
  │ queue_result_blocking│ Read (poll)   │ Direct read (snapshot)         │
  └──────────────────────┴───────────────┴────────────────────────────────┘
```
