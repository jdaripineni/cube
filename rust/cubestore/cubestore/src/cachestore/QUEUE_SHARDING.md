# CubeStore Queue Throughput Optimization

## Executive Summary

CubeStore's query queue processes all operations (heartbeat, retrieve,
ack, add, cancel) through a **single OS thread**. Under multi-pod deployments,
this creates a linear increase in queue latency as pod count grows — manifesting
as 10-20s delays in query processing.

This document describes a two-stage optimization strategy:
- **Stage 1**: Sharded RW loop within a single CubeStore router (5-8x throughput)
- **Stage 2**: Multiple independent CubeStore routers with prefix-based partitioning (linear horizontal scale)

---

## Key Terminology

### WAL (Write-Ahead Log)

RocksDB (the embedded key-value store CubeStore uses) persists every write
through a **Write-Ahead Log** before applying it to the in-memory data structure.

```
  Application                    RocksDB internals
  ───────────                    ─────────────────

  db.write(batch)  ─────────►  ┌──────────────────────────────┐
                               │         WAL File             │
                               │                              │
                               │  Sequential append-only log  │
                               │  of all write operations.    │
                               │                              │
                               │  Purpose:                    │
                               │  • Crash recovery (replay)   │
                               │  • Durability guarantee      │
                               │  • Atomicity of WriteBatch   │
                               │                              │
                               │  Constraint:                 │
                               │  • Single file per DB        │
                               │  • Writes are SERIALIZED     │
                               │    (one writer at a time)    │
                               │  • Protected by internal     │
                               │    mutex                     │
                               └──────────────┬───────────────┘
                                              │
                                              ▼
                               ┌──────────────────────────────┐
                               │       MemTable               │
                               │  (in-memory sorted map)      │
                               │                              │
                               │  After WAL write succeeds,   │
                               │  data is applied here for    │
                               │  fast reads.                 │
                               └──────────────────────────────┘
```

**Why this matters for sharding**: Even with N parallel shard threads preparing
WriteBatches concurrently, the final `db.write(batch)` call serializes at the
WAL mutex. This is why Stage 1 has a ceiling (~12-16 shards) — beyond that point,
threads spend more time waiting for the WAL mutex than doing useful work.

The WAL write is extremely fast (microseconds for small batches) because it's a
sequential append, not a random I/O seek. This is why 8 shards still achieve ~8x
improvement — the WAL serialization overhead is negligible relative to the total
operation time (read + validate + build batch + notify).

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
  5. (executes query)

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
  5. (executes query)

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
| Failover | Instance loss = prefix unavailable until restart | Acceptable for query queue (retries) |

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

## Test Coverage

The original Stage 1 implementation shipped with unit tests for `queue_add` validation
behavior, but **zero concurrency/thread-safety tests** for the sharded RW loop itself --
i.e. nothing that would actually fail if the guarantees in "Correctness Guarantees" / "No
Dirty Reads" / "No Side Effects Across Items" above were violated. The following tests close
that gap. They live in the existing `#[cfg(test)] mod tests` block in `cache_rocksstore.rs`
(grep for `test_queue_`).

They exercise the sharded path with shard counts > 1 via a new test-only constructor,
`RocksCacheStore::prepare_test_cachestore_with_queue_workers(name, config, num_queue_workers)`,
which pins an explicit shard count directly (bypassing `RocksCacheStore::new_from_store`'s env
var read) instead of mutating the process-global `CUBESTORE_QUEUE_RW_WORKERS` env var. Setting
that env var directly from a test would be unsafe: `cargo test` runs many `#[tokio::test]`
functions in this binary concurrently across OS threads, and other tests construct their own
cachestores (reading that same env var) at arbitrary times, so a shared mutable env var would
race across unrelated tests. All new tests use
`#[tokio::test(flavor = "multi_thread", worker_threads = 8)]` so spawned pod tasks get real
parallelism.

| Test | Correctness claim it backs | What it does |
| --- | --- | --- |
| `test_queue_retrieve_concurrency_limit_never_exceeded` | "Concurrency limit" row (per-prefix active count never exceeds `allow_concurrency`) -- the core "phantom read" risk | 8 shards, 30 distinct pending items under one prefix, `allow_concurrency=3`, all RETRIEVE concurrently; asserts `active.len()` from *every* returned response (not just a final count) never exceeds 3, and exactly 3 succeed |
| `test_queue_same_key_race_no_lost_updates` | "Per-item ordering" row + "No Dirty Reads" §1 (same routing key -> same shard -> FIFO) | 20 rounds; each round races 10 concurrent heartbeats against one ack and one cancel, all on the SAME item key; asserts exactly one of ack/cancel wins (never both, never neither), no panics, and the item is fully gone afterward |
| `test_queue_cross_item_isolation` | "No Side Effects Across Items" section | 25 items under 25 distinct prefixes (landing on varied shards), each concurrently heartbeated 5x then acked with a unique result string; verifies every item's stored ack result matches only its own task's write, never another item's |
| `test_queue_counters_match_ground_truth_after_churn` | "Crash recovery: counters rebuilt from RocksDB" row + the general no-drift claim for `QueueActiveCounters` | 4 prefixes x 10 items, concurrent add/retrieve/ack/cancel churn; compares the incrementally-maintained atomic counter (both before *and* after calling `rebuild_queue_active_counters()`) against an independent RocksDB scan (`queue_list` with an Active filter) -- must match exactly in both cases |
| `test_queue_workers_1_vs_8_equivalence` | "Backward compat" row (`workers=1` == upstream single-thread behavior) | Runs the same deterministic (sequential, not concurrent) add/heartbeat/retrieve/ack/cancel sequence once against a workers=1 store and once against a workers=8 store; asserts identical outcomes at every step |

### Verified "has teeth"

A test suite that never fails isn't proof of anything by itself. Per this task's own
requirement, `test_queue_retrieve_concurrency_limit_never_exceeded` was validated by
temporarily reintroducing the exact bug it exists to catch: commenting out
`let _guard = retrieve_lock.lock().await;` in `queue_retrieve_by_path`
(`cache_rocksstore.rs`), i.e. removing the per-prefix mutex that "No Dirty Reads" §1 relies
on to prevent concurrent RETRIEVEs (routed to *different* shards, since routing is by item
path) from racing past the ground-truth check on stale reads.

With the guard removed and run 5 times back to back:

```
run 1: FAILED -- active items exceeded allow_concurrency: saw 10 active, limit was 3
run 2: ok
run 3: FAILED -- active items exceeded allow_concurrency: saw 10 active, limit was 3
run 4: FAILED -- active items exceeded allow_concurrency: saw 10 active, limit was 3
run 5: FAILED -- active items exceeded allow_concurrency: saw 9 active, limit was 3
```

4 of 5 runs caught the violation outright (the 5th is not a false negative in the test logic --
it's the race window sometimes not being hit, which is expected for a genuine race; the fact
that violations of 9-10 active items against a limit of 3 showed up at all is the point). With
the guard restored, the same test passed 5/5 consecutive runs. This is the concrete evidence
that the test would catch a real regression of this bug, not just that it passes today.

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

## Benchmark Results

**Environment caveat**: these numbers come from a single local laptop, not a k8s cluster:
Apple M4 Max, 14 logical cores (`sysctl -n hw.ncpu`), 36 GB RAM, RocksDB on local SSD, single
CubeStore process, macOS/arm64, release build. There is no network hop, no real multi-pod
contention, and no other tenants competing for the same cores. Treat these as *indicative of
direction and rough magnitude*, not an SLA, and not a substitute for a real staging/k8s
measurement before rolling `CUBESTORE_QUEUE_RW_WORKERS` out widely. The earlier ASCII charts
in this document (e.g. "8x improvement", "~2,000 ops/sec") are the original illustrative
design-time estimates; the numbers below are what was actually measured against this branch's
code, using the benchmark in `benches/cachestore_queue_concurrent.rs` (see "Repeatable
Benchmark Process" below for exact commands).

### What's benchmarked

`benches/cachestore_queue_concurrent.rs` spawns `BENCH_PODS` concurrent async tasks ("pods"),
each looping `BENCH_ITERS_PER_POD` times through the real lifecycle: `queue_add` ->
`queue_retrieve_by_path` -> `queue_heartbeat` (x `BENCH_HEARTBEATS_PER_ITEM`) -> `queue_ack`.
It measures aggregate throughput (total ops / wall-clock) and per-operation-type p50/p90/p99
latency. Both runs below use 100 pods x 20 iterations x 3 heartbeats/item = 12,000 total ops,
release build (`--release`; a debug build would not be representative of real op costs).

Two scenarios were measured, because they tell materially different stories:

- **Scenario A -- one shared queue** (`BENCH_PREFIXES=1`, the default): all 100 pods contend
  for the same queue prefix, matching this document's earlier "single shared queue" diagrams.
- **Scenario B -- multi-tenant** (`BENCH_PREFIXES=100`): each pod has its own queue prefix, a
  more realistic model of independent tenants/customers each with their own query queue.

### Scenario A: one shared queue prefix (worst case for RETRIEVE)

| Shards (`CUBESTORE_QUEUE_RW_WORKERS`) | ops/sec | retrieve p50 / p99 (ms) | heartbeat p50 / p99 (ms) | ack p50 / p99 (ms) |
| --- | --- | --- | --- | --- |
| 1 (before)  | 15,638 | 33.86 / 67.01 | 0.225 / 0.710 | 0.345 / 0.762 |
| 4           | 17,596 | 30.32 / 74.53 | 0.030 / 0.492 | 0.029 / 0.355 |
| 8 (after)   | 17,583 | 30.14 / 76.70 | 0.028 / 0.445 | 0.028 / 0.126 |
| 16          | 17,471 | 31.70 / 72.25 | 0.027 / 0.354 | 0.028 / 0.116 |

- **Aggregate throughput speedup, workers=8 vs workers=1: 1.12x** (17,583 / 15,638) -- modest,
  and this is a real, structural result, not measurement noise (see below for why).
- **Per-op latency speedup, workers=8 vs workers=1: heartbeat p50 8.0x faster (0.225ms ->
  0.028ms), ack p50 12.3x faster (0.345ms -> 0.028ms).**
- **retrieve latency barely changes with shard count (~30-34ms p50 at every shard count).**
  This is expected, not a bug: `queue_retrieve_by_path` acquires a **per-prefix** `tokio::Mutex`
  (`retrieve_lock`) that serializes the entire read-check-write decision for RETRIEVE *within
  one prefix*, by design (see "No Dirty Reads" above) -- that lock is orthogonal to
  `CUBESTORE_QUEUE_RW_WORKERS`. With 100 pods hammering a single shared prefix, RETRIEVE
  throughput for that prefix has a hard ceiling independent of shard count, and since RETRIEVE
  is the slowest op in the loop, it dominates wall-clock time and caps the *aggregate*
  ops/sec improvement even though heartbeat/ack (which back the bulk of production hot-path
  traffic -- see "Appendix: How Pods Discover Unpicked Queries") speed up by an order of
  magnitude underneath it.

### Scenario B: multi-tenant, one prefix per pod (independent queues)

| Shards (`CUBESTORE_QUEUE_RW_WORKERS`) | ops/sec | retrieve p50 / p99 (ms) | heartbeat p50 / p99 (ms) | ack p50 / p99 (ms) | add p50 / p99 (ms) |
| --- | --- | --- | --- | --- | --- |
| 1 (before)  | 48,293 | 2.255 / 14.82 | 2.152 / 10.71 | 2.264 / 15.03 | 0.055 / 3.842 |
| 4           | 60,728 | 0.108 / 0.739 | 0.109 / 0.640 | 0.115 / 0.625 | 6.589 / 35.37 |
| 8 (after)   | 71,291 | 0.078 / 0.195 | 0.068 / 0.212 | 0.073 / 0.204 | 7.824 / 9.850 |
| 16          | 81,598 | 0.070 / 0.137 | 0.058 / 0.151 | 0.062 / 0.150 | 6.903 / 7.619 |

- **Aggregate throughput speedup, workers=8 vs workers=1: 1.48x** (71,291 / 48,293); **workers=16
  vs workers=1: 1.69x** (81,598 / 48,293).
- **retrieve/heartbeat/ack p50 latency speedup, workers=8 vs workers=1: ~29-32x** (e.g. ack:
  2.264ms -> 0.073ms). With independent prefixes, RETRIEVE's per-prefix lock no longer
  serializes *across* pods (each pod's prefix has its own lock), so the sharded write path's
  parallelism shows through directly here -- this is closer to what the original design-time
  "8x" estimate was gesturing at, for the ops that are actually sharded.
- **Diminishing returns above ~8 shards** are visible here too (71,291 @ 8 shards -> 81,598 @
  16 shards is a further 1.14x, not another 2x), consistent with the document's qualitative
  "WAL serialization ceiling" story, even though the exact shard count where it bites differs
  from the illustrative chart (expected -- this is 14 cores, not the chart's hypothetical
  fleet).

### Surprise finding: `queue_add` is not sharded, and it shows

`queue_add` goes through the original single-thread `write_operation_queue` path, not
`write_operation_queue_sharded` (confirmed directly in `cache_rocksstore.rs` -- see "Appendix:
Operation Classification" below, which is corrected accordingly). In Scenario B, `add` p50
latency gets **worse** as shard count increases: 0.055ms at workers=1, up to 6.6-7.8ms at
workers=4/8/16. This is not noise -- it reproduced consistently across repeated runs. The
mechanism: once RETRIEVE/heartbeat/ACK are fast (sharded), each pod loops through its 20
iterations much faster and comes back around to its next `queue_add` call sooner, so all 100
pods pile onto the *one* remaining single-threaded queue (`rw_loop_queue_cf`) far more
densely than they did when the rest of the loop was slow enough to naturally space `add` calls
out. Relieving contention downstream exposes contention upstream. This means `queue_add` is a
reasonable candidate for a future "Stage 1.5" (shard it too, keyed by item path like the other
write ops) if `add` throughput becomes a bottleneck in practice -- worth flagging since it
wasn't obvious from reading the design doc alone, only from actually running a workload shaped
like production traffic.

---

## Repeatable Benchmark Process

1. **Build in release mode** (required -- debug-mode timings are not representative):
   ```sh
   cd rust/cubestore
   cargo build -p cubestore --release --bench cachestore_queue_concurrent
   ```
   Find the resulting binary once (its hash suffix is stable across incremental rebuilds
   unless dependencies change):
   ```sh
   find target/release/deps -maxdepth 1 -iname 'cachestore_queue_concurrent-*' -perm -u+x -type f
   ```

2. **Run "before" (workers=1) and "after" (workers=8, or whatever you're validating)** for
   each scenario you care about. Always `rm -rf` the previous run's DB dir first (the binary
   reuses `cubestore/db-tmp/benchmarks/cachestore_queue_concurrent_bench_w<N>/` per shard
   count and does not truncate it automatically):
   ```sh
   cd cubestore
   BIN=../target/release/deps/cachestore_queue_concurrent-<hash>

   # Scenario A: one shared queue (default BENCH_PREFIXES=1)
   rm -rf db-tmp/benchmarks/cachestore_queue_concurrent_bench_w1
   CUBESTORE_QUEUE_RW_WORKERS=1 BENCH_PODS=100 BENCH_ITERS_PER_POD=20 BENCH_HEARTBEATS_PER_ITEM=3 "$BIN"

   rm -rf db-tmp/benchmarks/cachestore_queue_concurrent_bench_w8
   CUBESTORE_QUEUE_RW_WORKERS=8 BENCH_PODS=100 BENCH_ITERS_PER_POD=20 BENCH_HEARTBEATS_PER_ITEM=3 "$BIN"

   # Scenario B: multi-tenant, one prefix per pod
   rm -rf db-tmp/benchmarks/cachestore_queue_concurrent_bench_w1
   CUBESTORE_QUEUE_RW_WORKERS=1 BENCH_PODS=100 BENCH_ITERS_PER_POD=20 BENCH_HEARTBEATS_PER_ITEM=3 BENCH_PREFIXES=100 "$BIN"

   rm -rf db-tmp/benchmarks/cachestore_queue_concurrent_bench_w8
   CUBESTORE_QUEUE_RW_WORKERS=8 BENCH_PODS=100 BENCH_ITERS_PER_POD=20 BENCH_HEARTBEATS_PER_ITEM=3 BENCH_PREFIXES=100 "$BIN"
   ```
   All `BENCH_*` env vars are optional; see the doc comment at the top of
   `cachestore_queue_concurrent.rs` for the full list and defaults. Shard counts tested for
   this baseline: 1, 4, 8, 16.

3. **How to read the output**: the tool prints, per run, `aggregate throughput: N ops/sec`
   (total ops / wall-clock across all concurrent pods) and a table of p50/p90/p99/max latency
   per operation type (`add`/`retrieve`/`heartbeat`/`ack`), plus an "overall" row combining all
   op types. Compare like-for-like: same `BENCH_PODS`/`BENCH_ITERS_PER_POD`/`BENCH_PREFIXES`
   across the workers values you're comparing, since those parameters materially change both
   the absolute numbers and which op dominates wall-clock time (see Scenario A vs B above).

4. **Comparing a future run against this baseline**: re-run the exact commands above (same
   `BENCH_*` values) and diff the "ops/sec" and per-op p50/p99 lines against the tables in
   this section. A regression looks like: aggregate ops/sec dropping at a fixed shard count,
   or a previously-sharded op's (heartbeat/ack/retrieve/cancel) p50 latency drifting back
   toward its workers=1 value even at higher shard counts (that would suggest the sharding
   itself broke, e.g. shards silently collapsing to 1, or a new lock serializing what used to
   be parallel). Re-run 2-3 times before concluding a change is real -- these are wall-clock
   timings on a shared laptop and will have some run-to-run variance (the numbers above showed
   +/-10% or so across repeated runs at the same configuration).

5. Do **not** compare debug-build numbers to this baseline, and do not compare runs with
   different `BENCH_PODS`/`BENCH_ITERS_PER_POD`/`BENCH_PREFIXES` to each other directly --
   normalize on ops/sec and latency percentiles, not raw wall-clock time, if you change the
   op count.

---

## Appendix: Operation Classification

```
  ┌──────────────────────┬───────────────┬────────────────────────────────┐
  │ Operation            │ Type          │ Routing Strategy               │
  ├──────────────────────┼───────────────┼────────────────────────────────┤
  │ queue_add            │ Write         │ NOT sharded -- single RW loop  │
  │                      │               │ (see note below)               │
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

**Correction (found while benchmarking, see "## Benchmark Results" -> "Surprise finding")**:
`queue_add` is implemented via the original single-thread `write_operation_queue`, not
`write_operation_queue_sharded` -- confirmed directly in `cache_rocksstore.rs`. It does not
shard by item path today. This table previously said otherwise; the code is the source of
truth. This is a reasonable candidate for a future "Stage 1.5" if `add` throughput becomes a
bottleneck in practice.

---

## Appendix: How Pods Discover Unpicked Queries

A common question: if heartbeats for different items run in parallel across
shards, how does a pod know which queries haven't been picked up yet?

**Answer**: Heartbeats have nothing to do with query discovery. They are separate
concerns:

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                    QUEUE OPERATION RESPONSIBILITIES                      │
  ├──────────────────────┬──────────────────────────────────────────────────┤
  │                      │                                                  │
  │  queue_add           │  Pod submits a new query to the queue.           │
  │                      │  Creates item with status=Pending.               │
  │                      │                                                  │
  │  queue_retrieve      │  Pod asks: "give me a pending item to execute."  │
  │  (WITH PREFIX LOCK)  │  Finds Pending item → marks Active → returns it. │
  │                      │  THIS is how pods discover unpicked queries.     │
  │                      │                                                  │
  │  queue_heartbeat     │  Pod says: "I'm still working on item X."        │
  │                      │  Updates the heartbeat timestamp so the item     │
  │                      │  isn't considered orphaned/timed-out.            │
  │                      │  Has NO role in discovery.                       │
  │                      │                                                  │
  │  queue_ack           │  Pod says: "I finished item X, here's the result."│
  │                      │  Marks item as Completed with result payload.    │
  │                      │                                                  │
  │  queue_cancel        │  Pod (or timeout) says: "abandon item X."        │
  │                      │  Removes item from active processing.            │
  │                      │                                                  │
  │  queue_list / get    │  Any pod can read the full queue state at any    │
  │  (DIRECT READS)      │  time via a RocksDB snapshot. This is used for   │
  │                      │  monitoring, not for execution coordination.     │
  │                      │                                                  │
  └──────────────────────┴──────────────────────────────────────────────────┘
```

### The Coordination Model

```
  Pod A                          CubeStore                         Pod B
  ─────                          ─────────                         ─────

  1. queue_add(query-123)
     status=Pending  ──────────► [stored in RocksDB]

                                                          2. queue_retrieve(prefix, limit=3)
                                                             │
                                                             ├─ acquire prefix lock
                                                             ├─ check counter: active < limit?
                                                             ├─ find Pending items
                                                             ├─ mark query-123 as Active
                                                             ├─ increment counter
                                                             ├─ release prefix lock
                                                             │
                                                             ◄── returns query-123 to Pod B

                                                          3. Pod B executes query-123
                                                             queue_heartbeat(query-123) every N sec
                                                             (keeps item alive, prevents timeout)

                                                          4. queue_ack(query-123, result)
                                                             status=Completed

  5. Pod A polls for result:
     queue_result_blocking(query-123)
     ◄───────────────────────────────── returns result
```

### Why Parallel Operations on Different Items Are Safe

The safety of parallelism applies to ALL operation types, not just heartbeats:

```
  Shard 2                            Shard 5
  (item-X ops)                       (item-Y ops)
  ──────────────────────────────     ──────────────────────────────
  • HEARTBEAT item-X                 • ACK item-Y (with result)
  • ACK item-X                       • HEARTBEAT item-Y
  • CANCEL item-X                    • ADD item-Z (new query)

  Every operation on item-X:         Every operation on item-Y:
  • Reads ONLY item-X keys           • Reads ONLY item-Y keys
  • Writes ONLY item-X keys          • Writes ONLY item-Y keys
  • Modifies ONLY item-X state       • Modifies ONLY item-Y state

  The fundamental invariant:
  ┌─────────────────────────────────────────────────────────────────┐
  │ An operation on item A NEVER reads or writes any key belonging  │
  │ to item B. Therefore, executing A-ops and B-ops in parallel     │
  │ produces the EXACT same result as executing them sequentially.  │
  │                                                                 │
  │ This holds for heartbeat, ack, cancel, add — ALL write ops.    │
  └─────────────────────────────────────────────────────────────────┘

  The ONLY cross-item shared state is the per-prefix active counter,
  which uses lock-free atomic CAS — safe for concurrent access by design.
```

### What About Orphan Detection?

If a pod crashes without acking, its items' heartbeats stop. Another mechanism
(outside the hot path) periodically scans for items whose heartbeat is stale:

```
  Orphan detection (background, infrequent):

  1. queue_list (direct read) → get all Active items
  2. For each: if now() - heartbeat_ts > timeout → queue_cancel(item)
  3. Item returns to Pending (or is removed), counter decremented

  This scan is:
  • Infrequent (every 30-60s, not on the hot path)
  • A direct read (doesn't go through RW shards)
  • Safe to run concurrently with heartbeats (snapshot isolation)
```
