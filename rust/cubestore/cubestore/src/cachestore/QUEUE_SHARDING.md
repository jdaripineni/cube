# CubeStore Queue Sharding

## Overview

By default, all CubeStore queue operations (heartbeat, retrieve, ack, add, cancel)
execute on a single RW thread — preserving the upstream serialized behavior. This
guarantees correctness but creates a throughput bottleneck when many Cube.js pods
contend on the same CubeStore router.

The sharded queue RW loop distributes operations across N worker threads, routing
by item key so that operations on the **same queue item** remain serialized while
operations on **different items** execute in parallel.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CUBESTORE_QUEUE_RW_WORKERS` | `1` | Number of sharded RW worker threads for queue operations. Set to `1` to preserve original single-threaded behavior. |

### Recommended values

Each shard is a dedicated OS thread that can saturate one CPU core under load.
The CubeStore router container's CPU request/limit must accommodate the shard
threads **plus** the existing threads (tokio runtime, RocksDB compaction, upload
loop, metrics loop — typically 2–4 cores baseline).

| Scenario | Workers | Min CPU (cores) | Recommended CPU | Rationale |
|----------|---------|-----------------|-----------------|-----------|
| Default / safe rollout | `1` | 2 | 4 | Identical to upstream; baseline threads only |
| Small deployment (1-4 Cube.js pods) | `4` | 6 | 8 | 4 shard threads + ~2–4 baseline |
| Medium deployment (5-20 pods) | `8` | 10 | 12 | 8 shard threads + ~2–4 baseline |
| Large deployment (20+ pods) | `12`–`16` | 14–18 | 16–20 | Diminishing returns beyond this due to WAL serialization |

**Formula**: `recommended CPU cores ≈ CUBESTORE_QUEUE_RW_WORKERS + 4`

The `+4` accounts for:
- Tokio async runtime threads (defaults to number of CPUs, but queue-heavy workloads
  are offloaded to shard threads)
- RocksDB background compaction threads (configured separately via `CUBESTORE_MAX_BACKGROUND_JOBS`)
- Upload loop + metrics loop (1 thread each)

> **Do not exceed 16 shards.** RocksDB WAL writes are still serialized at the OS level.
> Beyond ~16 threads you'll see increased CPU spin with marginal throughput gains.
> Additionally, exceeding your pod's CPU limit causes throttling, which is worse than
> fewer shards with dedicated cores.

## How it works

1. **Sharded write pool**: Each shard is a dedicated OS thread with a bounded mpsc
   channel (capacity 32,768). Operations are routed by hashing the item's routing key.

2. **Atomic active counters**: Lock-free `AtomicU32` counters track how many queue
   items are "active" per prefix. This allows `RETRIEVE` to reject requests in O(1)
   when the concurrency limit is already met, without scanning RocksDB.

3. **Per-prefix retrieve locks**: `RETRIEVE` operations within the same prefix are
   serialized via a per-prefix Mutex. This ensures the concurrency limit is respected
   even under high parallelism. Different prefixes retrieve in parallel.

4. **Direct reads**: Read-only operations use `spawn_blocking` + RocksDB snapshots
   instead of routing through the RW loop, eliminating head-of-line blocking from
   writes.

## Correctness guarantees

- With `CUBESTORE_QUEUE_RW_WORKERS=1`: behavior is **identical** to upstream
  (single-threaded, fully serialized).
- With `CUBESTORE_QUEUE_RW_WORKERS>1`:
  - Per-item operations (heartbeat, ack) remain serialized (same routing key → same shard).
  - Per-prefix concurrency limits are correct (atomic CAS + per-prefix Mutex).
  - Cross-item reads use snapshot isolation (not serializable) — acceptable because
    queue items are independent entities.

## Monitoring

Watch for these symptoms when tuning:
- **High p99 latency on RETRIEVE**: prefix lock contention — indicates one prefix has
  too many concurrent retrieve attempts. This is expected under orchestrator isolation
  with high tenant concurrency.
- **Channel full errors in logs**: increase channel capacity or reduce load. The
  default 32,768 capacity should handle burst traffic.
- **Increasing RocksDB write stall metrics**: too many shards causing WAL contention.
  Reduce `CUBESTORE_QUEUE_RW_WORKERS`.
