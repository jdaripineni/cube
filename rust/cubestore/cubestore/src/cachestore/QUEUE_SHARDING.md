# CubeStore Queue Throughput Optimization

## Executive Summary

CubeStore's query queue processes all operations (heartbeat, retrieve,
ack, add, cancel) through a **single OS thread**. Under multi-pod deployments,
this creates a linear increase in queue latency as pod count grows — manifesting
as 10-20s delays in query processing.

This document describes a two-stage optimization strategy:
- **Stage 1**: Sharded RW loop within a single CubeStore router
- **Stage 2**: Multiple independent CubeStore routers with prefix-based partitioning (linear horizontal scale)

**What Stage 1 actually delivers, measured**: the "5-8x throughput" figure above was a
design-time estimate, not a measurement -- see "## Benchmark Results" for what was actually
observed once Stage 1 was tested end-to-end. The short version: aggregate throughput
improvement ranges from modest (1.1x) to solid (1.5-1.7x) depending on whether pods share one
queue prefix or have independent ones, because RETRIEVE has its own correctness-driven
serialization that sharding doesn't remove. The benefit that holds regardless of that
tenancy shape is different, and arguably more important operationally: heartbeat and ack stop
queueing behind unrelated pods' work (8-30x faster, depending on scenario). See "### Why This
Matters: Heartbeat/Ack Latency and Orphan Detection" below for why that specifically matters,
not just that it's faster.

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

### Why This Matters: Heartbeat/Ack Latency and Orphan Detection

The "waits for 11 ops" -> "immediate (no queue)" change for heartbeat in the diagram above
isn't just a latency number -- it removes a specific failure mode.

**The mechanism, precisely**: before Stage 1, every queue operation for every item from every
pod was pushed onto **one mpsc channel feeding one OS thread**, which drains it strictly in
arrival order. If pod B's slow `queue_retrieve` (for item Y) happened to be enqueued just
before pod A's `queue_heartbeat` (for item X), the heartbeat could not run until that retrieve
finished -- even though heartbeat-for-X and retrieve-for-Y touch entirely different RocksDB
keys and have no logical dependency on each other. The single thread has no way to know that;
it is FIFO over everything.

`ShardedRocksStoreRWLoop` fixes this by routing every operation via `schedule_keyed`, which
hashes the **item's own key** (`QueueKey::to_routing_key()`, i.e. its path or id) mod N to pick
one of N independent OS threads (each with its own channel). Two operations on the *same* item
always land on the same shard, so per-item ordering is preserved. Two operations on
*different* items usually land on *different* shards (~1-in-N chance of colliding), so pod A's
heartbeat for item X and pod B's retrieve for item Y are very likely on separate threads
entirely -- the heartbeat is no longer blocked by that retrieve, only by whatever else happens
to hash to its own shard, a much smaller slice of total traffic.

One nuance worth being precise about, since it also explains why RETRIEVE itself doesn't get
faster while heartbeat/ack do: RETRIEVE has a *second, separate* serialization point -- the
per-prefix `retrieve_lock` in `queue_retrieve_by_path`, added specifically so the
concurrency-limit check-then-act stays correct (see "No Dirty Reads" above). That lock is
orthogonal to shard count, so RETRIEVE-vs-RETRIEVE on the same prefix still queues no matter
how many shards exist. Heartbeat and ack don't need that lock, so they get the full benefit of
shard-level parallelism -- which is exactly why the real benchmark (see "## Benchmark Results")
showed heartbeat/ack getting 8-12x faster even in the worst-case scenario where RETRIEVE
latency stayed flat.

**Why the latency itself matters, not just the number**: heartbeats exist so a pod can say "I'm
still working on item X" and keep it from being treated as orphaned. The `heartbeat_timeout`
check (`filter_to_cancel` in `cache_rocksstore.rs`, exercised by the background orphan scan --
see "What About Orphan Detection?" in the appendix below) looks at wall-clock time since the
last recorded heartbeat, with no way to distinguish "the pod died" from "the pod's heartbeat call is alive
and well but stuck in line behind someone else's slow retrieve." Before Stage 1, a busy queue
could make that second case common: a heartbeat delayed long enough by queueing (not by the pod
actually failing) would cross `heartbeat_timeout`, get the item cancelled via `queue_cancel`,
and return a perfectly healthy, still-in-progress query to Pending -- wasting the work already
done and forcing a retry. Sharding removes the specific cause of that false positive: heartbeat
latency is no longer coupled to how much unrelated queue traffic exists, only to per-shard
load, which the benchmark shows is dramatically lower.

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
each looping `BENCH_ITERS_PER_POD` times through the same per-query lifecycle a real Cube.js
pod goes through against the queue (see "Appendix: How Pods Discover Unpicked Queries" / "The
Coordination Model" above): `queue_add` (submit a query) -> `queue_retrieve_by_path` (claim a
pending item) -> `queue_heartbeat` repeated `BENCH_HEARTBEATS_PER_ITEM` times (simulating the
periodic "still working on it" calls a pod makes while actually executing a query) ->
`queue_ack` (hand back the result). This is deliberately *not* an arbitrary mix of the four
operation types -- it's the real per-item call pattern, run concurrently across many
simulated pods, which is what makes the per-operation-type latency numbers below meaningful for
the "why heartbeat/ack latency matters" discussion above rather than just a synthetic load
test. It measures aggregate throughput (total ops / wall-clock) and per-operation-type
p50/p90/p99 latency. Both runs below use 100 pods x 20 iterations x 3 heartbeats/item = 12,000
total ops, release build (`--release`; a debug build would not be representative of real op
costs).

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

## Does Stage 1 Reduce Query Pickup (Queue-Wait) Latency?

A natural follow-up to the heartbeat/ack speedup story above: "the heartbeat speedup is the big
winner -- won't that eliminate the 3-30s query queue-wait-before-pickup that's been the main
complaint?" This section answers that directly, with new benchmarks built specifically to
isolate the question, because the existing Scenario A/B benchmarks above can't answer it on
their own.

### The conceptual clarification

Heartbeat getting faster is not the same thing as a *new* query getting picked up faster. As
"Appendix: How Pods Discover Unpicked Queries" above states plainly: "Heartbeats have nothing to
do with query discovery." A pod calls `queue_heartbeat` for a query it has *already* retrieved
and is currently executing -- it is a "still working" signal, nothing more. A brand new query
becomes eligible for execution only via `queue_retrieve_by_path` (`queue_add` puts it in the
queue; `queue_retrieve_by_path` is what actually finds it and marks it `Active`). So "does Stage
1 reduce the 3-30s pickup wait" is really the question "does Stage 1 make `queue_retrieve_by_path`
faster for a *new* query, when there's a lot of *other* queue traffic happening at the same
time" -- not "does heartbeat get faster" (it does, dramatically, per the Scenario A/B tables
above -- that's already established and is not what's being tested here).

Two different RETRIEVE-related contention patterns exist, and they behave differently under
sharding:

1. **RETRIEVE-vs-RETRIEVE on the same prefix** (many pods simultaneously trying to grab a new
   item from the same shared queue): serialized by the per-prefix `retrieve_lock`
   (`queue_retrieve_by_path`, "No Dirty Reads" §4 above), which is completely orthogonal to
   `CUBESTORE_QUEUE_RW_WORKERS`. Already shown not to improve with shard count in Scenario A
   above (retrieve p50 ~30-34ms at every shard count, 100 pods). Experiment 2 below re-tests
   this at a much wider range of pod counts to see if that picture changes at scale.
2. **RETRIEVE-vs-background-heartbeat/ack-noise** (one pod submitting a *new* query while many
   *other*, already-executing queries are heartbeating/acking in the background): a
   fundamentally different interaction that Scenario A/B's lockstep-everyone-does-everything
   design cannot isolate, because every pod in those benchmarks is *also* trying to retrieve at
   the same time. Experiment 1 below isolates it with a dedicated benchmark.

### Experiment 1: background heartbeat/ack noise vs. new-query pickup latency

**New benchmark**: `benches/cachestore_queue_pickup_latency.rs` (`harness = false`, registered
in `Cargo.toml` the same way as the existing benches). Design:

- Pre-populate `BG_ITEMS` items under one shared prefix, `queue_add`ed then immediately
  `queue_retrieve_by_path`ed by the setup phase itself (with a very high `allow_concurrency` so
  every one succeeds and stays `Active`) -- these simulate `BG_ITEMS` already-executing queries.
- Spawn `BG_ITEMS` long-running background tasks, each looping `queue_heartbeat` on its own item
  with a target minimum gap of `BG_HEARTBEAT_INTERVAL_MS` (default 10ms) for the entire duration
  of the measurement phase below.
- A single foreground submitter (`FG_SUBMITTERS=1` -- deliberately *not* many, so this
  experiment does not also measure RETRIEVE-vs-RETRIEVE contention, which is Experiment 2's job)
  repeatedly (`FG_ITERS` times): `queue_add`s a uniquely-pathed new item under the *same* shared
  prefix, then `queue_retrieve_by_path`s that exact path (also with a very high
  `allow_concurrency`, so only latency is measured, never admission blocking). The combined
  add+retrieve time is recorded as "pickup latency." Each foreground item is `queue_ack`ed
  immediately after (untimed), so only `BG_ITEMS` -- not the foreground loop itself -- determines
  how many items are `Active` under the shared prefix throughout the run.

`BG_HEARTBEAT_INTERVAL_MS=10` and `FG_SUBMITTERS=1` were held constant; `FG_ITERS` was reduced
from 100 to 60 (`BG_ITEMS=5000`) and 40 (`BG_ITEMS=10000`) purely to bound wall-clock time as
population cost grows (see below) -- the `BG_ITEMS=10000` p99/max figures therefore rest on
fewer samples (40) than the smaller rows (100) and are noisier as a result (at n=40, p99 and max
frequently coincide -- an artifact of the percentile-rank formula at low sample counts, not a
real physical ceiling).

**A note on population cost**: `queue_retrieve_by_path` doesn't just serialize per-prefix -- it
also does a `get_rows_by_index(ByPrefixAndStatus(prefix, Active))` scan that returns *every*
currently-Active item under that prefix on *every* call, regardless of shard count. Populating
`BG_ITEMS` items sequentially therefore costs roughly O(`BG_ITEMS`^2) total (each new item's
retrieve scans all previously-added active items) -- consistent with what was actually measured:
population took 2.5s at 2,000 items, 15s at 5,000, and 63-67s at 10,000. This is a one-time setup
cost, not part of the timed measurement, but it's why `BG_ITEMS=10000` runs take over a minute
before the timed phase even starts.

**Isolating the mechanism**: before trusting the headline numbers below, a diagnostic confirmed
*why* pickup latency grows with `BG_ITEMS` -- is it the per-call active-item scan above (a fixed
RocksDB read cost, independent of traffic and shard count), or actual channel/thread contention
from background heartbeat *traffic*? At `BG_ITEMS=2000`, workers=1, with
`BG_HEARTBEAT_INTERVAL_MS=10` (dense background traffic), `fg_retrieve_only` p50 was 43.96ms.
Re-run with everything else identical but `BG_HEARTBEAT_INTERVAL_MS=5000` (near-zero background
traffic during the measurement window), `fg_retrieve_only` p50 dropped to 2.21ms -- an ~18x
difference for the *same* number of Active items under the prefix. This confirms the effect
below is overwhelmingly driven by background *traffic* competing for the RW loop's
channel/thread capacity, not by the fixed active-item-scan cost (which is real, but small
relative to traffic-driven queueing delay) -- i.e., it is precisely the interaction Stage 1's
sharding targets.

**Results** (`BG_HEARTBEAT_INTERVAL_MS=10`, `FG_SUBMITTERS=1`, release build, single laptop
process, `FG_ITERS=100` except where noted):

| BG_ITEMS | Workers | fg_pickup p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | bg_heartbeat p50 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 0.091 | 0.169 | 1.764 | 2.116 | n/a (no background load) |
| 0 | 8 | 0.083 | 0.183 | 0.815 | 9.021 | n/a |
| 50 | 1 | 0.164 | 0.265 | 0.803 | 1.635 | 0.338 |
| 50 | 8 | 0.189 | 0.254 | 0.335 | 0.341 | 0.168 |
| 200 | 1 | 0.484 | 0.955 | 1.439 | 1.487 | 0.460 |
| 200 | 8 | 0.499 | 0.797 | 1.715 | 3.693 | 0.270 |
| 500 | 1 | 3.592 | 4.658 | 8.550 | 8.779 | 2.447 |
| 500 | 8 | 1.403 | 2.052 | 2.516 | 2.517 | 0.564 |
| 1000 | 1 | 14.991 | 18.999 | 23.873 | 26.862 | 14.019 |
| 1000 | 8 | 4.943 | 6.577 | 8.555 | 8.875 | 0.925 |
| 2000 | 1 | 44.188 | 48.427 | 56.455 | 74.253 | 40.335 |
| 2000 | 8 | 18.622 | 22.583 | 24.653 | 29.873 | 9.160 |
| 5000 | 1 (FG_ITERS=60) | 134.806 | 155.228 | 181.975 | 184.325 | 121.744 |
| 5000 | 8 (FG_ITERS=60) | 68.295 | 75.515 | 96.579 | 140.116 | 44.255 |
| 10000 | 1 (FG_ITERS=40) | 287.378 | 333.001 | 361.361 | 361.361 | 263.607 |
| 10000 | 8 (FG_ITERS=40) | 147.857 | 185.780 | 366.653 | 366.653 | 93.519 |

`fg_add_only` stayed sub-millisecond (0.04-0.75ms) at every `BG_ITEMS`/workers combination, as
expected, since `queue_add` is unsharded and background load in this experiment is pure
heartbeat traffic that never touches the add queue -- `fg_pickup` is therefore driven almost
entirely by `fg_retrieve_only` throughout the table.

**What this shows**:

- **Below ~200-500 background items, sharding makes no measurable difference** to pickup
  latency (`BG_ITEMS=50`: 0.164ms vs 0.189ms; `BG_ITEMS=200`: 0.484ms vs 0.499ms -- both within
  noise, and workers=8 is not even reliably ahead at this scale). At this level of background
  load, neither configuration is close to saturating the RW loop, so there's nothing for
  sharding to relieve.
- **From ~500 background items up, sharding delivers a clear, substantial win**: pickup p50
  speedup (workers=1 / workers=8) is 2.56x at 500 items, peaks at 3.03x at 1,000 items, then
  gradually narrows to 2.37x (2,000), 1.97x (5,000), and 1.94x (10,000) as background load grows
  further -- consistent with this document's existing "WAL serialization ceiling" story: at very
  high absolute load, `workers=8` itself starts to saturate, so the *relative* advantage over
  `workers=1` shrinks even as the *absolute* latency at `workers=8` keeps climbing.
- **The magnitude reaches "tens to hundreds of milliseconds," but nowhere near the reported
  3-30 *second* real-world symptom.** The largest scale tested (`BG_ITEMS=10000`) reached 287ms
  (workers=1) vs 148ms (workers=8) pickup p50 -- both comfortably under half a second, three
  orders of magnitude short of "3-30s." This is not a failure of the experiment; it reflects a
  real difference between this environment and a production k8s deployment (see "Environment
  caveat" in the existing Benchmark Results section above): single local process, no network
  hop, no real multi-pod OS/process-level contention, fast local SSD, and only 14 cores worth of
  total scheduling pressure. Pushing `BG_ITEMS` further (beyond 10,000) was not attempted:
  population cost grows roughly quadratically (see above), and 10,000 items already took over a
  minute just to set up, so continuing to push this single-process local benchmark toward
  multi-second pickup latency would mean modeling a scale of background contention (tens of
  thousands of simultaneously active items under one prefix) that is not representative of the
  real deployments this feature targets anyway. The trend (2-3x speedup, growing background load
  driving growing absolute latency at both shard counts) is reported with confidence; whether it
  extrapolates to closing the full 3-30s gap in a real k8s cluster is a claim this benchmark
  cannot make either way.

### Experiment 2: does RETRIEVE-vs-RETRIEVE contention get worse at higher pod counts, and does sharding ever help?

**Extended sweep**: the existing `cachestore_queue_concurrent.rs` Scenario A configuration
(`BENCH_PREFIXES=1`, all pods share one queue prefix), run at `BENCH_PODS` in {100, 250, 500,
1000} x `CUBESTORE_QUEUE_RW_WORKERS` in {1, 8}. `BENCH_ITERS_PER_POD` was reduced from the
existing baseline's 20 to 10 (`BENCH_HEARTBEATS_PER_ITEM` kept at 3) purely to keep
`BENCH_PODS=1000` runs from taking several minutes -- total ops (up to 60,000 at the largest
point) is what matters for stable percentiles, not the iters value specifically, per the
existing "Repeatable Benchmark Process" guidance below.

**Results**:

| BENCH_PODS | Workers | ops/sec | retrieve p50 (ms) | p90 (ms) | p99 (ms) |
| --- | --- | --- | --- | --- | --- |
| 100 | 1 | 23,091.4 | 22.904 | 34.093 | 35.363 |
| 100 | 8 | 26,976.1 | 19.471 | 31.007 | 33.483 |
| 250 | 1 | 12,164.5 | 110.618 | 180.336 | 198.661 |
| 250 | 8 | 13,009.6 | 102.675 | 193.463 | 199.293 |
| 500 | 1 | 6,104.3 | 405.318 | 822.845 | 920.098 |
| 500 | 8 | 5,822.6 | 425.837 | 1005.581 | 1086.985 |
| 1000 | 1 | 2,552.2 | 1736.652 | 4411.597 | 5077.599 |
| 1000 | 8 | 2,228.7 | 2092.978 | 5189.866 | 5840.903 |

**What this shows**:

- **RETRIEVE latency against one shared prefix grows steeply, and clearly superlinearly, with
  pod count** -- retrieve p50 goes from 20-23ms (100 pods) to 100-111ms (250 pods) to 405-426ms
  (500 pods) to 1.7-2.1 *seconds* (1000 pods), at both shard counts. This directly confirms the
  queueing-theory prediction: once arrival rate at the per-prefix `retrieve_lock` exceeds its
  service rate, wait time grows faster than pod count, and it does so regardless of
  `CUBESTORE_QUEUE_RW_WORKERS` -- the lock has no notion of shards.
- **At 100-250 pods, `workers=8` still shows the same small, consistent edge as the original
  100-pod Scenario A baseline** (ops/sec 1.07-1.17x higher, retrieve p50 5-8% lower) --
  presumably residual scheduling-overhead differences (fewer heartbeat/ack ops queueing behind
  each other between successive retrieves on the same shard), not a change to the
  fundamentally-serialized RETRIEVE path itself.
- **At 500 and especially 1000 pods, that small edge disappears and even nominally reverses**:
  at 1000 pods, `workers=8` measured *worse* than `workers=1` (ops/sec 2,228.7 vs 2,552.2;
  retrieve p50 2,092.978ms vs 1,736.652ms, roughly 20% higher). Per this document's honesty
  requirements, this was checked rather than taken at face value: a follow-up re-run of just
  `BENCH_PODS=1000` at a smaller `BENCH_ITERS_PER_POD=5` (fewer total ops, less statistically
  solid, but a fast independent sample) showed the *opposite* ordering on some metrics
  (`workers=8` ops/sec 5,741.5 vs `workers=1`'s 5,651.3; retrieve p50 752.8ms vs 810.8ms) and the
  *same* ordering on others (p90/p99 slightly higher for `workers=8`) -- i.e., inconsistent
  between runs. **Conclusion: the apparent "workers=8 is worse at 1000 pods" result in the
  primary run is not a robust, reproducible effect -- it's noise**, most likely from this being a
  14-core laptop running both the async runtime's worker threads *and* (at workers=8) 8
  additional dedicated RW shard OS threads simultaneously with 1000 concurrent pod tasks, i.e.
  thread-oversubscription noise, not a real regression introduced by sharding. The honest,
  defensible reading of Experiment 2 as a whole: **once RETRIEVE-vs-RETRIEVE contention on a
  single shared prefix is severe enough (500+ concurrent pods in this environment),
  `CUBESTORE_QUEUE_RW_WORKERS` has no reliable effect on it in either direction** -- consistent
  with, and a stronger confirmation of, the per-prefix-lock analysis in "No Dirty Reads"
  elsewhere in this document. This was *not* re-run 2-3 times at every pod count (per the
  existing "Repeatable Benchmark Process" §4 recommendation) due to time budget; the 100-250 pod
  rows are consistent with the original Scenario A baseline and are trustworthy, but the
  500/1000 rows' *exact* numbers should be treated as one representative sample of a noisy
  regime, not a precise measurement.

### Verdict

**Does Stage 1 reduce new-query pickup latency when there's heavy background heartbeat/ack noise
from other, already-executing queries?** Yes, measurably, starting once background load is large
enough to matter (roughly 500+ concurrently-active items sharing a prefix in this environment) --
pickup latency speedups of 2-3x were measured, growing to hundreds of milliseconds of *absolute*
latency at the highest background-load levels tested. This is a real, reproducible,
traffic-driven effect (confirmed by the interval-based diagnostic above), and it is
mechanistically distinct from -- and does not contradict -- the fact that Stage 1 does *not* help
RETRIEVE-vs-RETRIEVE contention on a shared prefix (Experiment 2, and the existing Scenario A
above): those are two different bottlenecks (channel/thread contention from *background* traffic
vs. the per-prefix `retrieve_lock`'s inherent serialization of *simultaneous new-query
submissions*), and Stage 1's sharding only ever addresses the first one.

**Does this close the reported real-world "3-30s" pickup-wait complaint?** Not provably, and not
close, on this local single-process laptop benchmark -- the largest, most background-loaded
scenario tested here (10,000 simultaneously active background items) produced pickup latency in
the hundreds of milliseconds, not seconds. Whether the *ratio* (roughly 2-3x, narrowing to ~2x at
the largest scale tested) extrapolates to closing a multi-second gap in a real k8s deployment --
where network round-trips, many separate OS processes, real RocksDB I/O contention under
production data volumes, and far higher total pod counts all raise the *absolute* magnitude of
every number in these tables -- is a reasonable hypothesis this data is consistent with, but it
is not a claim this benchmark can prove. **The honest summary: Stage 1 helps the "background
noise slows down new-query pickup" mechanism, meaningfully and by a growing absolute margin as
background load grows, but does not help (and this data suggests may occasionally even show
noise-level non-improvement in) the "many pods simultaneously fighting to retrieve from the same
queue" mechanism -- and a production validation on real infrastructure, not just this laptop, is
still needed before concluding it resolves the full 3-30s symptom.**

### Repeatable Commands (Experiments 1 and 2)

**Experiment 1 (background-noise vs. pickup latency)**:

```sh
cd rust/cubestore
cargo build -p cubestore --release --bench cachestore_queue_pickup_latency
find target/release/deps -maxdepth 1 -iname 'cachestore_queue_pickup_latency-*' -perm -u+x -type f
cd cubestore
BIN=../target/release/deps/cachestore_queue_pickup_latency-<hash>

for BG in 0 50 200 500 1000 2000; do
  for W in 1 8; do
    rm -rf "db-tmp/benchmarks/cachestore_queue_pickup_latency_bench_w${W}"
    CUBESTORE_QUEUE_RW_WORKERS=$W BG_ITEMS=$BG BG_HEARTBEAT_INTERVAL_MS=10 \
      FG_SUBMITTERS=1 FG_ITERS=100 FG_WARMUP_MS=300 "$BIN"
  done
done

# Larger scale (population cost grows ~quadratically -- budget 1-2 minutes for BG_ITEMS=10000):
for BG in 5000 10000; do
  for W in 1 8; do
    rm -rf "db-tmp/benchmarks/cachestore_queue_pickup_latency_bench_w${W}"
    CUBESTORE_QUEUE_RW_WORKERS=$W BG_ITEMS=$BG BG_HEARTBEAT_INTERVAL_MS=10 \
      FG_SUBMITTERS=1 FG_ITERS=40 FG_WARMUP_MS=300 "$BIN"
  done
done
```

**Experiment 2 (RETRIEVE-vs-RETRIEVE contention at scale)**:

```sh
cd rust/cubestore/cubestore
BIN=../target/release/deps/cachestore_queue_concurrent-<hash>  # built per step 1 above

for PODS in 100 250 500 1000; do
  for W in 1 8; do
    rm -rf "db-tmp/benchmarks/cachestore_queue_concurrent_bench_w${W}"
    CUBESTORE_QUEUE_RW_WORKERS=$W BENCH_PODS=$PODS BENCH_ITERS_PER_POD=10 \
      BENCH_HEARTBEATS_PER_ITEM=3 BENCH_PREFIXES=1 "$BIN"
  done
done
```

---

## Production Incident Repro: ~40 Pods, Shared Prefix, Realistic Concurrency Limits

A production report described intermittent query queue-wait (pickup) latency **spikes** up to
30 seconds against a ~40-pod Cube.js deployment, ~300 cubes/data models, query concurrency
configured somewhere in the 10-50+ range (exact value unknown), typical query execution
sub-second to ~2s. This section builds a new benchmark specifically to reproduce and diagnose
that symptom, because both benchmarks above have a gap that matters for it: neither models
realistic query hold/execution time (items are ack'd near-immediately after retrieve), and
neither uses a realistic, finite `allow_concurrency` (both pass a value large enough that
admission blocking essentially never triggers). Without hold time, `Active` count for a prefix
never sustains meaningful size; without a finite concurrency limit, admission blocking
(`QueueRetrieveResponse::NotEnoughConcurrency`) never happens at all -- both are central to how
production actually behaves.

### Recap of the two established facts this builds on

1. **Cube identity never enters the CubeStore queue key.** The prefix is built from
   `(orchestratorId, dataSource)` only (`SQL_QUERY_<orchestratorId>_<dataSource>` /
   `SQL_PRE_AGGREGATIONS_<orchestratorId>_<dataSource>`, see
   `packages/cubejs-query-orchestrator/src/orchestrator/QueryCache.ts` and
   `PreAggregations.ts`), so a typical single-tenant/single-datasource deployment funnels
   through one (or two, counting pre-aggregations separately) shared CubeStore queue prefix
   regardless of cube count. This is why the repro below uses **one shared prefix**, matching
   Scenario A / Experiment 2 above, not the multi-prefix Scenario B.
2. **`queue_retrieve_by_path` scans the entire prefix's item lists on every single call**,
   guarded by a per-prefix `retrieve_lock` that fully serializes RETRIEVE-vs-RETRIEVE for a
   prefix regardless of `CUBESTORE_QUEUE_RW_WORKERS` (`cache_rocksstore.rs`,
   `queue_retrieve_by_path`; see "No Dirty Reads" §4 and "Surprise finding" above for where this
   is already documented). Reading the function directly for this task surfaced a **refinement**
   worth calling out explicitly: the function does two separate index scans on *every* call
   (both the fast-path `NotEnoughConcurrency` check and the actual write path) --
   `count_rows_by_index(ByPrefixAndStatus(prefix, Pending))` and
   `get_rows_by_index(ByPrefixAndStatus(prefix, Active))`. Both bottom out in
   `get_row_ids_by_index` (`rocks_table.rs`), which iterates the RocksDB secondary index range
   for that `(prefix, status)` key -- i.e. genuinely `O(matching row count)`, not O(1). The
   **Active** list is bounded by `allow_concurrency` by construction (the code explicitly never
   lets `active.len()` exceed the limit), so its scan cost is capped at a constant for a fixed
   `allow_concurrency`. The **Pending** count, however, is *not* bounded by anything -- it grows
   without limit as backlog builds whenever arrival rate exceeds drain rate. This means the
   *primary* engine of the feedback loop hypothesized in the original task framing is more
   precisely: growing **Pending backlog** (not Active count) makes every subsequent retrieve
   call more expensive (via the Pending-count scan), which slows the rate at which backlog
   drains, which lets more items pile up -- with the bounded Active-list scan contributing a
   fixed additive cost on top that shifts (but doesn't drive) the exact threshold. See "What the
   sweep shows" below for the empirical confirmation and how `allow_concurrency` modulates that
   additive cost.

### The new benchmark

`benches/cachestore_queue_production_repro.rs` (`harness = false`, registered in `Cargo.toml`
the same way as the other two). Design:

- **One shared prefix** (`PROD#shared`) for all traffic.
- **`PODS` concurrent "pod" tasks**, each looping continuously for the run duration: `queue_add`
  a uniquely-pathed new item -> retry `queue_retrieve_by_path` (with a finite
  `ALLOW_CONCURRENCY`) every `POLL_INTERVAL_MS` until `Success` -> hold the item `Active` for
  `HOLD_MS` (`tokio::time::sleep`, standing in for real warehouse query execution time) ->
  `queue_ack`. This is a **closed-loop** demand model (a fixed population of concurrent
  submitters, each doing one full cycle at a time), which is the right model for "N concurrent
  in-flight queries", as opposed to an open-loop fixed arrival rate.
- **Pickup latency** = wall-clock from the start of `queue_add` to the moment
  `queue_retrieve_by_path` returns `Success` for that same path, including all failed-retry
  polling in between -- literally "time from submission to being picked up," what the reported
  3-30s symptom is about.
- Samples are only recorded for cycles that *start* after `WARMUP_MS` has elapsed (steady-state
  only).
- A background **monitor task** samples the prefix's current Active and Pending item counts
  every `ACTIVE_SAMPLE_INTERVAL_MS` via `queue_list` (a direct snapshot read, bypassing the RW
  loop/retrieve_lock) -- this is what lets the tables below show backlog growth directly,
  testing the feedback-loop hypothesis head-on.
- A **hard safety timeout** (`HARD_TIMEOUT_GRACE_MS` past the nominal run end) force-stops the
  benchmark and reports whatever samples completed if some pods are still stuck retrying --
  otherwise a genuine cascade could make the benchmark hang indefinitely. Whenever a table below
  reports `hard_timeout=true`, the `p90`/`p99`/`max` figures in that row are **right-censored at
  the grace boundary** (`WARMUP_MS + RUN_MS + HARD_TIMEOUT_GRACE_MS` from start) -- the true tail
  could be worse than shown. The dedicated "uncensored tail" runs further below use a much larger
  grace window specifically to get past this artifact.
- `POLL_INTERVAL_MS=100` was used throughout (within the task's suggested 50-200ms range): the
  real Cube.js client uses a longer blocking-wait + reconcile pattern with a default 5s
  `continueWaitTimeout`, but a shorter interval here is more conservative/revealing for finding
  the contention mechanism itself (it generates more retrieve attempts per unit time, not fewer).

Reproduction (single run):

```sh
cd rust/cubestore
cargo build -p cubestore --release --bench cachestore_queue_production_repro
find target/release/deps -maxdepth 1 -iname 'cachestore_queue_production_repro-*' -perm -u+x -type f
cd cubestore
BIN=../target/release/deps/cachestore_queue_production_repro-<hash>

rm -rf db-tmp/benchmarks/cachestore_queue_production_repro_bench_w1
CUBESTORE_QUEUE_RW_WORKERS=1 PODS=800 HOLD_MS=500 ALLOW_CONCURRENCY=20 \
  RUN_MS=3000 WARMUP_MS=300 HARD_TIMEOUT_GRACE_MS=5000 "$BIN"
```

### Sweep 1: locating the threshold (`HOLD_MS=500`, `ALLOW_CONCURRENCY=20`, i.e. theoretical max throughput `C/(H/1000) = 40 items/sec`)

`RUN_MS=3000, WARMUP_MS=300, HARD_TIMEOUT_GRACE_MS=5000, POLL_INTERVAL_MS=100` throughout.

| PODS | demand ratio (PODS/C) | Workers | throughput (items/s) | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | n | pending_max | hard_timeout |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 0.5x | 1 | 20.00 | 0.425 | 12.148 | 14.133 | 14.148 | 60 | 7 | false |
| 20 | 1.0x | 1 | 40.00 | 1.252 | 2.224 | 4.209 | 4.278 | 120 | 6 | false |
| 40 | 2.0x | 1 | 40.00 | 1.798 | 4.277 | 6.489 | 6.588 | 120 | 30 | false |
| 100 | 5.0x | 1 | 40.00 | 2.383 | 3.280 | 5.756 | 5.768 | 120 | 89 | false |
| 250 | 12.5x | 1 | 40.00 | 1.414 | 2.075 | 2.399 | 2.448 | 120 | 230 | true |
| 500 | 25.0x | 1 | 40.00 | 1.172 | 1.856 | 2.800 | 2.922 | 120 | 480 | true |
| 1000 | 50.0x | 1 | 8.67 | 4016.292 | 6020.187 | 7023.758 | 7023.758 | 26 | 980 | true |
| 2000 | 100.0x | 1 | 17.00 | 3007.306 | 7022.647 | 7516.002 | 7516.002 | 51 | 1980 | true |
| 10 | 0.5x | 8 | 20.00 | 0.586 | 2.023 | 2.666 | 2.800 | 60 | 4 | false |
| 20 | 1.0x | 8 | 40.00 | 1.169 | 2.923 | 4.866 | 4.939 | 120 | 7 | false |
| 40 | 2.0x | 8 | 40.00 | 1.414 | 3.340 | 5.497 | 5.578 | 120 | 27 | false |
| 100 | 5.0x | 8 | 40.00 | 2.178 | 4.517 | 5.540 | 5.652 | 120 | 88 | false |
| 250 | 12.5x | 8 | 40.00 | 0.636 | 1.524 | 2.222 | 2.259 | 120 | 230 | true |
| 500 | 25.0x | 8 | 40.00 | 1.018 | 2.020 | 2.503 | 2.617 | 120 | 480 | true |
| 1000 | 50.0x | 8 | 11.00 | 4518.703 | 6016.887 | 6521.669 | 6521.669 | 33 | 980 | true |
| 2000 | 100.0x | 8 | 7.67 | 5515.384 | 6527.702 | 7027.987 | 7027.987 | 23 | 1980 | true |

A dramatic, non-linear jump appears between `PODS=500` (still sub-3ms across every percentile)
and `PODS=1000` (p50 jumps to **~4-4.5 seconds**, p99 to ~7s) -- at **both** shard counts, with no
meaningful difference between them. `hard_timeout=true` from `PODS=250` up is about the
*post-run drain-down* not finishing within the grace window (pods stop submitting *new* items at
`run_deadline` but already-submitted ones keep retrying) -- it does not by itself mean the
*reported* samples are compromised at the lower rows; it only becomes a right-censoring concern
once the reported latencies themselves approach the grace boundary (`PODS>=1000` rows).

### Sweep 2: fine-grained threshold localization (same `H=500, C=20`)

| PODS | Workers | throughput | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | n | pending_max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 550 | 1 | 34.33 | 1.335 | 1.978 | 2.580 | 2.734 | 103 | 530 |
| 600 | 1 | 29.67 | 1.352 | 2.273 | 2.857 | 2.970 | 89 | 580 |
| 650 | 1 | 24.00 | 1.460 | 2.675 | 2.930 | 2.965 | 72 | 630 |
| 700 | 1 | 24.33 | 1.367 | 4513.406 | 6517.998 | 6519.116 | 73 | 685 |
| 750 | 1 | 22.00 | 3.028 | 7018.930 | 7021.327 | 7022.564 | 66 | 730 |
| 800 | 1 | 15.00 | 3.383 | 4011.349 | 7516.228 | 7516.228 | 45 | 785 |
| 850 | 1 | 9.33 | 3013.771 | 5519.861 | 7515.996 | 7515.996 | 28 | 830 |
| 900 | 1 | 11.67 | 2004.235 | 6014.259 | 7526.878 | 7526.878 | 35 | 880 |
| 950 | 1 | 15.33 | 4516.798 | 5518.096 | 6520.246 | 6520.246 | 46 | 930 |
| 550 | 8 | 29.33 | 1.434 | 3564.702 | 4580.706 | 4580.707 | 88 | 530 |
| 600 | 8 | 24.33 | 1.222 | 2.222 | 2.770 | 2.790 | 73 | 580 |
| 650 | 8 | 24.33 | 1.410 | 1.956 | 2.594 | 2.716 | 73 | 630 |
| 700 | 8 | 17.00 | 1.442 | 2.991 | 3.540 | 3.540 | 51 | 680 |
| 750 | 8 | 26.67 | 1.906 | 6014.777 | 6021.299 | 6524.087 | 80 | 730 |
| 800 | 8 | 18.00 | 3.025 | 4019.716 | 8026.282 | 8028.814 | 54 | 780 |
| 850 | 8 | 11.33 | 3510.871 | 7521.913 | 8024.661 | 8024.661 | 34 | 830 |
| 900 | 8 | 7.67 | 3509.319 | 6019.921 | 6508.052 | 6508.052 | 23 | 880 |
| 950 | 8 | 15.67 | 3508.603 | 5011.318 | 5519.392 | 5519.392 | 47 | 930 |

The onset is sharp and, notably, **not a uniform shift of the whole distribution** -- at the
crossover (`PODS~650-750`) p50 often stays low (sub-2ms, most items still get lucky quickly)
while p90/p99 jump straight to multi-second territory. That is a **bimodal** pattern (most
requests fine, a growing minority stuck for seconds), which matches the reported "spikes,
not a constant baseline" symptom far better than a smooth latency-vs-load curve would.

### Sweep 2b: is the threshold crossing reproducible, or noise? (3 reruns each)

`PODS in {650, 700, 750}`, `H=500, C=20`, same run parameters, 3 independent runs per
`(PODS, workers)` combination:

| PODS | Workers | Run 1 p90/p99 (ms) | Run 2 p90/p99 (ms) | Run 3 p90/p99 (ms) |
| --- | --- | --- | --- | --- |
| 650 | 1 | 6014.4 / 6519.6 (cascading) | 2.24 / 2.57 (clean) | 2.45 / 2.65 (clean) |
| 700 | 1 | 6016.6 / 6533.2 (cascading) | 2.88 / 3.54 (clean) | 3.43 / 3.89 (clean) |
| 750 | 1 | 6011.6 / 6019.6 (cascading) | 6519.6 / 7021.4 (cascading) | 6516.4 / 7020.3 (cascading) |
| 650 | 8 | 3.19 / 6518.3 (tail only) | 2.78 / 3.27 (clean) | 3.12 / 3.36 (clean) |
| 700 | 8 | 3.19 / 5512.0 (tail only) | 6016.4 / 6518.4 (cascading) | 2.38 / 2.97 (clean, max=5556) |
| 750 | 8 | 6520.7 / 7024.8 (cascading) | 6519.6 / 7021.4 (cascading) | p50=3010.8, 6520.7 / 6528.4 (cascading) |

**This confirms the crossover is a genuine metastable/bistable region, not measurement noise
smoothing over a clean step function**: at 650-700 pods, whether a *given run* tips into cascade
or stays clean varies run to run (both outcomes observed repeatedly at both shard counts); by
750 pods, every single run (6/6 across both shard counts) cascades. This is arguably the most
production-relevant finding in this section -- it is a textbook description of intermittent
*spikes* rather than a deterministic threshold, because a system sitting near this capacity edge
can tip into a runaway retrieve-lock cascade or not depending on essentially random scheduling
fluctuations. It also reconfirms, across 18 additional paired runs, that **shard count does not
move where this crossover happens** -- workers=1 and workers=8 cascade at the same `PODS` range,
with no reliable ordering between them in either direction (also see the `H=200, PODS=700` reruns
below, where an earlier apparent "workers=8 is worse" result reverted to "same as workers=1" on
repeat -- consistent with this document's existing precedent that isolated results in the noisy
bistable region are not to be over-interpreted, see Experiment 2's own honesty note above).

### Sweep 3: does `HOLD_MS` shift the threshold? (`ALLOW_CONCURRENCY=20` fixed, `PODS` bracketing the `H=500` crossover found above)

| PODS | HOLD_MS | Workers | throughput | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | n | pending_max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 600 | 200 | 1 | 100.00 | 1.135 | 1.703 | 2.080 | 3262.980 | 300 | 580 |
| 700 | 200 | 1 | 78.33 | 1.838 | 4107.479 | 5444.687 | 5447.771 | 235 | 681 |
| 800 | 200 | 1 | 74.67 | 3211.141 | 6236.337 | 7309.882 | 7643.789 | 224 | 781 |
| 900 | 200 | 1 | 66.33 | 3227.768 | 5441.269 | 7031.142 | 8056.294 | 199 | 881 |
| 600 | 1000 | 1 | 14.33 | 1.246 | 2.249 | 2.681 | 2.681 | 43 | 580 |
| 700 | 1000 | 1 | 9.33 | 1.390 | 3.680 | 3.905 | 3.905 | 28 | 680 |
| 800 | 1000 | 1 | 5.67 | 3.277 | 5008.042 | 6011.853 | 6011.853 | 17 | 780 |
| 900 | 1000 | 1 | 0.67 | 5006.783 | 5006.783 | 5006.783 | 5006.783 | 2 | 880 |
| 600 | 2000 | 1 | 2.67 | 1.975 | 2.134 | 2.240 | 2.240 | 8 | 580 |
| 700 | 2000 | 1 | 1.67 | 6016.030 | 6017.348 | 6017.348 | 6017.348 | 5 | 680 |
| 800 | 2000 | 1 | 2.00 | 2.509 | 2.774 | 2.774 | 2.774 | 6 | 780 |
| 900 | 2000 | 1 | 1.67 | 6004.950 | 6007.537 | 6007.537 | 6007.537 | 5 | 880 |
| 600 | 200 | 8 | 100.00 | 1.096 | 1.769 | 2.292 | 204.128 | 300 | 580 |
| 700 | 200 | 8 | 90.00 | 1421.795 | 6731.182 | 7446.502 | 7447.250 | 270 | 682 |
| 800 | 200 | 8 | 74.00 | 2611.825 | 5633.696 | 6642.168 | 7472.062 | 222 | 780 |
| 900 | 200 | 8 | 62.00 | 4013.130 | 5845.966 | 7473.584 | 8080.710 | 186 | 880 |
| 600 | 1000 | 8 | 15.33 | 1.325 | 2.125 | 2.518 | 2.518 | 46 | 580 |
| 700 | 1000 | 8 | 10.00 | 2.088 | 4008.018 | 5011.015 | 5011.015 | 30 | 680 |
| 800 | 1000 | 8 | 6.33 | 2.463 | 6007.482 | 6012.097 | 6012.097 | 19 | 781 |
| 900 | 1000 | 8 | 0.67 | 4007.422 | 4007.422 | 4007.422 | 4007.422 | 2 | 880 |
| 600 | 2000 | 8 | 1.33 | 2.872 | 2.972 | 2.972 | 2.972 | 4 | 580 |
| 700 | 2000 | 8 | 1.67 | 1.672 | 6018.027 | 6018.027 | 6018.027 | 5 | 680 |
| 800 | 2000 | 8 | 1.33 | 3.438 | 3.582 | 3.582 | 3.582 | 4 | 780 |
| 900 | 2000 | 8 | 0.00 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 880 |

**Confirmatory reruns** (`H=200, PODS=700, C=20`, 2 more independent runs per shard count, to
check the one apparently-anomalous `workers=8` row above where p50 was already 1421.8ms):

| Run | Workers | p50 (ms) | p90 (ms) |
| --- | --- | --- | --- |
| 1 | 1 | 2.576 | 6230.787 |
| 1 | 8 | 205.823 | 6329.223 |
| 2 | 1 | 2.479 | 4913.130 |
| 2 | 8 | 2.739 | 5921.275 |

**What this shows**: the crossover point (in terms of `PODS`, i.e. absolute Pending backlog size,
since backlog `~= PODS - C` once saturated) is **essentially the same regardless of `HOLD_MS`**
(clean at 600, cascading somewhere in the 700-900 range, at `H` = 200, 500, 1000, and 2000 alike).
This is consistent with the mechanism identified above: the poll-driven retrieve-attempt rate is
`(PODS - C) / POLL_INTERVAL_MS`, independent of `H`; `H` mainly controls how fast admitted slots
free up (and therefore the *absolute* pickup latency once cascading, and how many samples fit in
a fixed `RUN_MS` window), not whether the Pending-scan cost crosses the point where the
per-prefix lock saturates. The one apparently-anomalous `workers=8` reading (`H=200, PODS=700,
p50=1421.8ms`) reverted to a normal, low value on both reruns above -- another instance of noise
in the bistable crossover region (see Sweep 2b), not a systematic shard-count effect.

### Sweep 4: does `ALLOW_CONCURRENCY` shift the threshold? (`HOLD_MS=500` fixed)

| PODS | ALLOW_CONCURRENCY | Workers | throughput | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | n | pending_max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 600 | 10 | 1 | 17.00 | 0.757 | 1.238 | 2.324 | 2.324 | 51 | 590 |
| 700 | 10 | 1 | 12.33 | 1.016 | 1.437 | 1.683 | 1.683 | 37 | 690 |
| 800 | 10 | 1 | 6.00 | 1.462 | 2.563 | 3011.836 | 3011.836 | 18 | 790 |
| 900 | 10 | 1 | 3.00 | 3510.235 | 5515.693 | 6511.647 | 6511.647 | 9 | 890 |
| 600 | 50 | 1 | 92.67 | 3514.225 | 5538.077 | 6657.512 | 7163.477 | 278 | 559 |
| 700 | 50 | 1 | 86.00 | 2050.031 | 5009.431 | 6113.878 | 7567.335 | 258 | 650 |
| 800 | 50 | 1 | 80.33 | 3520.082 | 6519.609 | 7052.980 | 7532.228 | 241 | 758 |
| 900 | 50 | 1 | 77.33 | 4022.066 | 6023.708 | 7526.274 | 7530.444 | 232 | 850 |
| 600 | 10 | 8 | 13.33 | 0.685 | 1.192 | 1.460 | 1.460 | 40 | 590 |
| 700 | 10 | 8 | 13.33 | 0.753 | 1.355 | 2.139 | 2.139 | 40 | 690 |
| 800 | 10 | 8 | 3.67 | 1.597 | 6514.354 | 6514.384 | 6514.384 | 11 | 790 |
| 900 | 10 | 8 | 1.67 | 4514.501 | 6511.202 | 6511.202 | 6511.202 | 5 | 890 |
| 600 | 50 | 8 | 99.67 | 5.738 | 5125.369 | 6677.719 | 6678.245 | 299 | 559 |
| 700 | 50 | 8 | 80.67 | 3020.573 | 5538.072 | 7515.401 | 7522.601 | 242 | 664 |
| 800 | 50 | 8 | 63.33 | 3512.122 | 5013.306 | 7520.112 | 7522.810 | 190 | 750 |
| 900 | 50 | 8 | 69.00 | 2512.213 | 6524.656 | 8032.957 | 8035.503 | 207 | 850 |

**This is the one axis where the threshold clearly does move, and the direction is
counter-intuitive**: at `ALLOW_CONCURRENCY=10`, the system stays clean through `PODS=700`
(backlog ~690) and only cascades by `PODS=900` (backlog ~890) -- a *higher* backlog tolerance
than the `C=20` case. At `ALLOW_CONCURRENCY=50`, the system is **already fully cascading at
PODS=600** (backlog only ~559) -- a *lower* backlog tolerance than `C=20`. In other words,
**raising `allow_concurrency` makes this specific cascade trigger at a *smaller* backlog, not a
larger one.** This matches the refined mechanism above: the Active-list scan is bounded by `C`
but still costs something on every call, so a larger `C` adds more fixed per-call overhead before
the unbounded Pending-count scan even starts growing -- shifting the point at which the
combined per-call cost saturates the per-prefix lock to occur at a smaller Pending backlog. This
is a genuine, non-obvious finding: naively "raise concurrency to relieve pressure" is not a clean
win against *this specific* cascade mechanism, because it also raises the fixed cost of every
future retrieve call. (It's still likely a net win for *overall admitted throughput* under
moderate load, per the `C/(H/1000)` relationship in Sweep 1 -- the tradeoff is scenario-dependent
and not something this benchmark alone can resolve; see Recommendations below.)

### Uncensored tail: how bad does it actually get if allowed to fully play out?

Every table above uses `HARD_TIMEOUT_GRACE_MS=5000`, which right-censors the worst rows (their
`p90`/`p99`/`max` cluster near the grace boundary -- an artifact of the cutoff, not the true
tail). To get an honest, *uncensored* read of the worst case, two points already known to be
past the threshold were re-run with a much larger grace window (`60s` / `90s`) so the benchmark
was allowed to fully drain naturally (`hard_timeout=false` in both cases below -- these are real,
complete measurements, not cut off):

| PODS | C | H | Workers | Wall-clock (s) | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 800 | 20 | 500 | 1 | 23.945 | 5510.389 | 18269.085 | 21385.915 | 22437.683 | 120 |
| 800 | 20 | 500 | 8 | 23.928 | 4516.239 | 19362.011 | 21415.707 | 21415.711 | 120 |
| 1000 | 20 | 500 | 1 | 28.773 | 16037.537 | 23181.254 | 25756.011 | 26761.680 | 120 |
| 1000 | 20 | 500 | 8 | 28.830 | 16562.015 | 22690.912 | 26793.778 | 27324.926 | 120 |

**This is the single most important result in this section.** Allowed to run uncensored, pickup
latency at `PODS=1000` reaches **p99 = 25.8-26.8s, max = 26.8-27.3s** -- within the same order of
magnitude as, and directly comparable to, the reported real-world "up to 30 seconds" symptom.
This is a materially closer match than Experiments 1/2 above achieved (those topped out at
hundreds of milliseconds, three orders of magnitude short of the 3-30s complaint) -- the
difference is precisely the combination this section adds: realistic finite `allow_concurrency`
plus realistic non-zero `HOLD_MS`, which together let a large, genuinely unbounded Pending
backlog accumulate the way it plausibly does in production. **And once again, `workers=1` vs
`workers=8` are statistically indistinguishable at both demand levels** (e.g. at `PODS=1000`:
p99 25756ms vs 26794ms, max 26762ms vs 27325ms) -- decisive, repeated confirmation that
`CUBESTORE_QUEUE_RW_WORKERS` has no effect on this specific cascade.

### Important caveat: what "PODS" means here vs. "~40 Cube.js pods" in production

The cascade in this section required `PODS` (concurrent submitting tasks in the closed-loop
model) in the many-hundreds to trigger -- nowhere close to "40." This is **not** a claim that 40
literal Cube.js pods themselves are insufficient to reproduce the symptom; it is a claim about
**concurrently in-flight/pending distinct queries against the shared prefix**, which is a
different quantity. A single Cube.js pod is a server process handling many simultaneous
end-user/dashboard requests, each of which can independently submit its own item to the same
shared CubeStore queue prefix (per established fact #1 above). With ~300 cubes/data models and
query concurrency already configured to 10-50+, it is entirely plausible for a traffic burst
across 40 pods to produce several hundred to low-thousands of concurrently-submitted distinct
queries funneling through the one shared prefix at once -- which is exactly the "spike" framing
in the original report (a transient burst, not a sustained baseline). This benchmark did **not**
attempt to model pods-vs-requests-per-pod directly (that would require assumptions about
per-pod HTTP concurrency this task has no data for); it isolates the CubeStore-side mechanism and
shows what backlog size triggers it. Whether real 40-pod bursts actually reach that backlog size
is a plausible, but not independently verified, extrapolation -- flagged honestly rather than
asserted.

### Verdict: Production Incident Repro

**Was the cascade/threshold hypothesis confirmed?** Yes, clearly and reproducibly. Pickup latency
stays flat (low single-digit milliseconds at p99) until a sharp, genuinely non-linear threshold,
past which it jumps to multi-second, and eventually (uncensored) tens-of-seconds, latency. The
threshold is a **bistable/metastable crossover** (Sweep 2b), not a clean deterministic step --
which is a better match for "spikes" than a smooth degradation curve would be.

**Where is the threshold?** In terms of absolute Pending backlog size (`~= PODS - allow_concurrency`
once saturated), roughly **650-750 items at `allow_concurrency=20`**, moving to **~550-650 at
`allow_concurrency=50`** and **~700-800+ at `allow_concurrency=10`** -- i.e., a *higher*
`allow_concurrency` triggers the cascade at a *smaller* backlog (Sweep 4), while `HOLD_MS` has
essentially no effect on where the threshold sits, only on the absolute latency and sample rate
once past it (Sweep 3).

**Does shard count (`CUBESTORE_QUEUE_RW_WORKERS`) affect this at all?** No. Across every sweep
above (Sweep 1 through the uncensored tail, ~100 total runs), `workers=1` and `workers=8` cross
the threshold at the same `PODS` range and reach the same order-of-magnitude latency once
cascading, with no reliable ordering between them -- fully consistent with, and a strong
additional confirmation of, this document's existing conclusion that the per-prefix
`retrieve_lock` (and now, more precisely, the unbounded Pending-count scan it guards) is entirely
orthogonal to `CUBESTORE_QUEUE_RW_WORKERS`. **Stage 1 alone does not, and structurally cannot,
fix this production symptom.**

### Recommendations

Given what was actually found (not what was assumed going in):

1. **Reduce the per-prefix retrieve scan cost -- new fix candidate, distinct from Stage 1/2.**
   This is the most direct, targeted fix for *this specific* mechanism: the root cause is that
   `queue_retrieve_by_path` re-derives the Pending count (and Active list) via a full RocksDB
   index scan on *every* call while holding an exclusive per-prefix lock. An analogous fix to the
   existing `QueueActiveCounters` (an atomic, incrementally-maintained counter instead of a
   per-call scan) applied to the **Pending** count specifically would remove the unbounded part
   of this cost entirely, independent of shard count. This is a genuine new finding from this
   task, not something Stage 1 (sharding the RW loop) or Stage 2 (multiple routers) were ever
   designed to address -- both leave the per-prefix lock and its O(backlog) scan fully intact.
2. **Do not treat "raise `allow_concurrency`" as a clean fix.** Sweep 4 shows raising
   `allow_concurrency` shifts this specific cascade's trigger point to a *smaller* Pending
   backlog, not a larger one, because it raises the fixed per-call Active-list-scan cost. It may
   still be worth raising for overall throughput reasons unrelated to this mechanism, but it is
   not a substitute for #1 and should not be assumed to relieve backlog pressure -- verify with
   this benchmark (or a real staging environment) before relying on it.
3. **Splitting the shared prefix** (e.g. by pre-aggregation table, or some other dimension) would
   directly reduce the backlog *per lock*, since the lock and scan are per-prefix. This is
   architecturally non-trivial given established fact #1 (cube identity isn't in the queue key
   today; this would require orchestrator/queue-key changes, similar in spirit to the Stage 2
   "Multiple CubeStore Routers" direction already sketched above, or a lower-effort in-process
   variant that shards *retrieve_lock/backlog* by some hash of the item path within one CubeStore
   instance). This section does not design that change, only flags it as a viable direction
   consistent with the data.
4. **`CUBESTORE_QUEUE_RW_WORKERS` (Stage 1) should not be presented as fixing this specific
   symptom.** It remains valuable for what it does fix (heartbeat/ack latency, per Experiment 1
   and the original Benchmark Results above), but this section's data is unambiguous: it has no
   measurable effect on the backlog-driven RETRIEVE cascade that most plausibly explains the
   reported 3-30s spikes.
5. **Confidence caveat**: like the rest of this document, all of the above comes from a single
   local laptop process (Apple M4 Max, 14 logical cores, RocksDB on local SSD) -- see the
   "Environment caveat" in the original Benchmark Results section. The uncensored `PODS=1000`
   result reaching ~27s max is a striking, order-of-magnitude match to the reported 30s symptom,
   but this is one local benchmark, not a production measurement; recommendation #1 (fixing the
   scan cost) is offered with reasonable confidence given how directly it follows from the code
   read in this section, but it has not been implemented or measured here -- it is a diagnosis
   and a proposed direction, not a validated fix.

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
