# CubeStore Queue Retrieve: Unbounded Pending-Count Scan Cost

## Status

Diagnosed and reproduced. **Not yet fixed.** This document is written to be resumable in a
fresh session with no memory of the investigation that produced it — it is self-contained.

Branch: `cubestore-retrieve-pending-scan-cost` (created from `master`, not from the unrelated
`cubestore-queue-sharding` branch — see "Why this is a separate branch" below).

## TL;DR

`queue_retrieve_by_path` recomputes the number of `Pending` items in a queue prefix via a full
RocksDB index scan on **every single call**, while holding an exclusive per-prefix lock. That
scan cost is unbounded — nothing caps how large the `Pending` backlog can grow — so once
concurrent demand transiently exceeds capacity, a self-reinforcing cascade kicks in: bigger
backlog makes every subsequent retrieve call slower, which slows backlog drain, which lets more
items pile up. Reproduced locally: pickup latency stays at low single-digit milliseconds up to a
sharp threshold, then jumps to multi-second, and in an uncensored run reached **p99 25.8s, max
26.8s** at a load level chosen to model a production report of intermittent 3-30s query
queue-wait spikes. This is independent of any thread/shard count — it is gated entirely by a
single per-prefix mutex and the O(backlog) scan it guards.

---

## 1. Problem Statement (the production report that started this)

Reported symptom: in a production Cube.js deployment (~40 pods, ~300 cubes/data models, query
concurrency already explicitly configured somewhere in the 10-50 range, typical query execution
time sub-second to ~2s against the backing warehouse), CubeStore query queue-wait time
(time from a query being submitted to it actually being picked up for execution) **spikes
intermittently up to 30 seconds** — not a constantly-elevated baseline, but bursty.

Two facts, established by tracing the actual Cube.js orchestrator code, reframe what "~40 pods,
300 cubes" actually means for CubeStore:

### 1a. Cube identity never enters the CubeStore queue key — 300 cubes is not 300 queues

The queue prefix used for per-prefix locking and concurrency admission is built from
`(orchestratorId, dataSource)` only:

- Normal queries: `SQL_QUERY_<orchestratorId>_<dataSource>`
  (`packages/cubejs-query-orchestrator/src/orchestrator/QueryCache.ts`, ~line 510)
- Pre-aggregation builds: `SQL_PRE_AGGREGATIONS_<orchestratorId>_<dataSource>`
  (`packages/cubejs-query-orchestrator/src/orchestrator/PreAggregations.ts`, ~line 692-693)

`orchestratorId` defaults to a single constant (`'STANDALONE'`) for an entire deployment unless a
custom `contextToOrchestratorId` splits it per tenant — it is never derived from cube identity.
The actual CubeStore-side path/prefix format is `redisQueuePrefix:md5(query)`
(`packages/cubejs-cubestore-driver/src/CubeStoreQueueDriver.ts`, `prefixKey`/`redisHash`), and
`QueueItem::parse_path` (`rust/cubestore/cubestore/src/cachestore/queue_item.rs`) splits on the
**last** colon — so the CubeStore-side prefix is exactly `redisQueuePrefix`, e.g.
`SQL_QUERY_STANDALONE_default`.

**Consequence**: a typical single-tenant, single-datasource deployment funnels through **one (or
two, counting pre-aggregations separately) shared CubeStore queue prefix**, regardless of having
300 cubes. This is why the repro below models one shared prefix under heavy concurrent load, not
300 independent ones.

### 1b. Default query concurrency is small, but was reported as already raised (10-50+)

`QueryQueue.ts`: `this.concurrency = options.concurrency || 2` (bare fallback); in practice
resolved via `CUBEJS_CONCURRENCY` env var / `queueOptions.concurrency` / driver default, commonly
landing around 5 if untouched. In the reported incident this was **already explicitly raised** to
somewhere in the 10-50 range — ruling out "just raise concurrency, it's still at the tiny
default" as the explanation. This matters for root-causing below: it means simple
under-provisioning of the concurrency slot count is *not* the primary story here.

### 1c. Fan-out: one user query is not one queue item

A single user-facing query can fan out into **multiple** queue items: one per
pre-aggregation/partition it needs built (`PreAggregations.ts` loops
`queryBody.preAggregations`, each going through its own `PreAggregationLoader.executeInQueue`),
plus one for the final SQL execution. So "~40 pods" understates how many concurrently in-flight
distinct queue items can exist against the one shared prefix at a given moment — see §3's
"PODS" caveat for how this benchmark models that gap.

---

## 2. Why this is a separate branch from `cubestore-queue-sharding`

A parallel, earlier investigation (branch `cubestore-queue-sharding`, PR
[jdaripineni/cube#2](https://github.com/jdaripineni/cube/pull/2)) added a sharded RW-loop
(`CUBESTORE_QUEUE_RW_WORKERS`, N independent OS threads keyed by item-path hash) intended to
relieve exactly this kind of queue contention. That work is real and does measurably help a
*different* mechanism (heartbeat/ack latency no longer queueing behind unrelated pods' work on a
single global thread — up to ~30x faster in some scenarios). But a dedicated, production-shaped
benchmark built during that investigation (see that branch's
`benches/cachestore_queue_production_repro.rs`, carried over unmodified to this branch — see
below) proved conclusively, across ~100 paired runs, that **shard count has zero effect on the
cascade this document is about**. `workers=1` and `workers=8` hit the same threshold at the same
load and reach the same order-of-magnitude latency once cascading (e.g. at load reproducing ~26s
of pickup latency, `workers=1` and `workers=8` differ by under 5%).

That makes sense once you look at *why*: the mechanism here is entirely inside
`queue_retrieve_by_path`'s per-prefix critical section (a `tokio::Mutex` that serializes
RETRIEVE-vs-RETRIEVE for one prefix, orthogonal to how many RW-loop shards exist) and the
RocksDB scan that critical section does on every call. Sharding the RW loop doesn't touch either
of those. **This is a pre-existing property of `queue_retrieve_by_path` on `master` today,
unrelated to and not introduced by the sharding branch, and not fixable by it.** Hence: separate
branch, separate fix, can be worked on and merged independently of whether/when the sharding PR
lands.

---

## 3. The Benchmark (carried over from the sharding-branch investigation)

`rust/cubestore/cubestore/benches/cachestore_queue_production_repro.rs` (already present on this
branch, registered in `cubestore/Cargo.toml`). Read its file-header doc comment for full design
details; summary:

- **One shared prefix** for all traffic (`PROD#shared`), matching §1a above.
- **`PODS` concurrent "pod" tasks**, each in a closed loop: `queue_add` a uniquely-pathed new
  item → retry `queue_retrieve_by_path` (with a **finite** `ALLOW_CONCURRENCY`, not an
  artificially huge value) every `POLL_INTERVAL_MS` until `Success` → hold the item `Active` for
  `HOLD_MS` (`tokio::time::sleep`, standing in for real warehouse query execution time) →
  `queue_ack`.
- **Pickup latency** = wall-clock from the start of `queue_add` to the moment
  `queue_retrieve_by_path` returns `Success` for that path, including all failed-retry polling —
  literally "time from submission to being picked up," what the reported 3-30s symptom is about.
- A background monitor samples the prefix's live `Active`/`Pending` counts via `queue_list`
  (direct read, doesn't perturb what's measured) every `ACTIVE_SAMPLE_INTERVAL_MS`.
- A hard safety timeout (`HARD_TIMEOUT_GRACE_MS`) prevents a genuine cascade from hanging the
  benchmark forever; rows using it are right-censored (flagged in the data below).

**Caveat on what "PODS" means**: the benchmark's closed-loop `PODS` count models *concurrently
in-flight/submitted distinct queue items*, not literal Cube.js pod count. Per §1c, with ~300
cubes and multi-item fan-out per query, it's plausible for a burst across 40 real pods to produce
several hundred to low-thousands of concurrently-submitted items against the one shared prefix —
but this benchmark does not attempt to model pods-vs-requests-per-pod directly (no data was
available for that assumption); it isolates the CubeStore-side mechanism and reports what backlog
size triggers it.

Reproduction:

```sh
cd rust/cubestore
cargo build -p cubestore --release --bench cachestore_queue_production_repro
find target/release/deps -maxdepth 1 -iname 'cachestore_queue_production_repro-*' -perm -u+x -type f
cd cubestore
BIN=../target/release/deps/cachestore_queue_production_repro-<hash>

# Quick sanity check (~6s wall-clock due to the default RUN_MS/WARMUP_MS window; should show
# flat low-ms latency -- verified in-session: p50=3.26ms, p99=5.06ms, max=5.18ms, n=200,
# pending high-water mark 39, well below the cascade threshold at this PODS/concurrency ratio):
CUBESTORE_QUEUE_RW_WORKERS=1 PODS=40 HOLD_MS=500 ALLOW_CONCURRENCY=20 "$BIN"

# The headline cascade (uncensored, ~24-29s wall clock, this is the important one):
rm -rf db-tmp/benchmarks/cachestore_queue_production_repro_bench_w1
CUBESTORE_QUEUE_RW_WORKERS=1 PODS=1000 HOLD_MS=500 ALLOW_CONCURRENCY=20 \
  RUN_MS=3000 WARMUP_MS=300 HARD_TIMEOUT_GRACE_MS=90000 "$BIN"
```

### Key results

(Subset. The full ~100-run sweep, including 3x reruns proving the threshold is
bistable/metastable rather than a clean step function, lives in the sharding branch's
`QUEUE_SHARDING.md` → "Production Incident Repro" section if you want the complete dataset.)

**Threshold location** (`HOLD_MS=500`, `ALLOW_CONCURRENCY=20`):

| PODS | Workers | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | pending_max |
| --- | --- | --- | --- | --- | --- | --- |
| 500 | 1 | 1.172 | 1.856 | 2.800 | 2.922 | 480 |
| 500 | 8 | 1.018 | 2.020 | 2.503 | 2.617 | 480 |
| 1000 | 1 | 4016.292 | 6020.187 | 7023.758 | 7023.758 (censored) | 980 |
| 1000 | 8 | 4518.703 | 6016.887 | 6521.669 | 6521.669 (censored) | 980 |

**Uncensored tail** (let fully drain, no artificial cutoff — the single most important result):

| PODS | Workers | Wall-clock (s) | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1000 | 1 | 28.773 | 16037.537 | 23181.254 | 25756.011 | 26761.680 |
| 1000 | 8 | 28.830 | 16562.015 | 22690.912 | 26793.778 | 27324.926 |

This was independently re-verified in-session (not just taken from a single run): a fresh repeat
of the `PODS=1000, workers=1` case produced p99=25653ms, max=26154ms, pending high-water mark
980 — matching the table above within ~2%.

**Fine-grained threshold localization** found the crossover at `HOLD_MS=500, ALLOW_CONCURRENCY=20`
sits around **650-750 concurrently in-flight items**, and — notably — is **bistable**: repeated
runs at the exact same `PODS` count sometimes cascade and sometimes don't in the 650-700 range,
converging to a reliable cascade only by ~750. This matches "intermittent spikes" far better than
a smooth degradation curve would.

**Counter-intuitive finding**: raising `ALLOW_CONCURRENCY` shifts the cascade to trigger at a
*smaller* backlog, not a larger one (`ALLOW_CONCURRENCY=50` cascades already by backlog ~559;
`ALLOW_CONCURRENCY=10` tolerates backlog up to ~800+). Mechanism: a larger concurrency limit means
the (bounded, but non-zero) Active-list scan costs more per call, adding fixed overhead that
brings the per-call cost to the saturation point sooner. **"Just raise concurrency" is not a
clean fix for this specific mechanism**, even though it may help for unrelated throughput reasons.

---

## 4. Root Cause

`queue_retrieve_by_path` in `rust/cubestore/cubestore/src/cachestore/cache_rocksstore.rs` does,
on **every single call** (both a fast-path admission check and the real write path):

```rust
let pending = queue_schema.count_rows_by_index(
    &QueueItemIndexKey::ByPrefixAndStatus(prefix.clone(), QueueItemStatus::Pending),
    &QueueItemRocksIndex::ByPrefixAndStatus,
)?;
```

`count_rows_by_index` (`rust/cubestore/cubestore/src/metastore/rocks_table.rs`, ~line 786) is:

```rust
fn count_rows_by_index<K: Debug + Hash>(&self, row_key: &K, secondary_index: &impl RocksSecondaryIndex<Self::T, K>) -> Result<u64, CubeError> {
    let rows_ids = self.get_row_ids_by_index(row_key, secondary_index)?;
    Ok(rows_ids.len() as u64)
}
```

This **materializes every matching row ID into a `Vec` just to return its length** — a genuine
`O(matching row count)` operation, not O(1). (Same file also does a real `get_rows_by_index` scan
for the `Active` list, but that one is bounded: the code never lets `active.len()` exceed
`allow_concurrency`, so its cost is capped at a constant for a fixed concurrency limit. The
**Pending** count has no such bound — nothing caps backlog size.)

All of this happens **while holding an exclusive per-prefix `tokio::Mutex`** (`retrieve_lock`,
acquired in `queue_retrieve_by_path` before any of the above) that fully serializes
RETRIEVE-vs-RETRIEVE for one prefix. Combine an unbounded per-call scan cost with full
serialization of that scan across every concurrent retriever, and you get the feedback loop: more
backlog → each retrieve call scans more rows → each call takes longer → the mutex holds longer →
the rate at which backlog can drain drops → more items accumulate while waiting → repeat. This is
what produces a sharp, non-linear threshold rather than a graceful degradation curve, and — per
the bistability finding above — genuine spikes rather than a constant elevated baseline.

**This scan logic is not new** — it predates the sharding branch's changes entirely (sharding
added the mutex and shard-routing *around* this pre-existing scan, it didn't introduce the scan
itself). It plausibly exists on `master` today, independent of any sharding work landing or not.

---

## 5. Solution Options

### Option A: In-process atomic counter (recommended as the pragmatic first fix)

Maintain a `Pending`-count analog of the sharding branch's `QueueActiveCounters`
(`rust/cubestore/cubestore/src/cachestore/queue_active_counters.rs` on the
`cubestore-queue-sharding` branch — worth reading directly as a design reference, even though this
branch doesn't carry that file over) — an `AtomicU32`/`AtomicI64` per prefix, incremented on
`queue_add`, decremented on whatever transitions an item out of `Pending` (`queue_retrieve_by_path`
success, `queue_cancel` if the item was still `Pending`), with a one-time rebuild-from-RocksDB scan
at startup (mirroring `rebuild_queue_active_counters()`, called once in `spawn_processing_loops`,
**not** periodically — confirmed by reading that call site).

**Pros**: proven pattern already in this codebase (as prior art on the other branch); trivial to
reason about; no RocksDB schema/API changes.
**Cons**: in-memory only (resets on restart, needs the startup rebuild — same O(n) cost class as
what we're avoiding, but paid once per restart instead of once per call, a large win); a future
code path that mutates `Pending` status without remembering to update the counter would cause
drift (see §6 for why this specific counter's drift has an unusually low blast radius).

### Option B: RocksDB merge operator (more architecturally "correct," more implementation effort)

This codebase already has working associative-merge-operator infrastructure — see
`meta_store_merge` in `rust/cubestore/cubestore/src/metastore/mod.rs` (~line 1247), a
`u64` accumulator registered via `opts.set_merge_operator_associative(...)` for the **metastore's**
RocksDB instance (`RocksMetaStoreDetails::open_db`). It appears currently unused/vestigial (no
`.merge()`/`.merge_cf()` call sites found anywhere in the metastore code), but it proves the
mechanism works in this exact fork. The **cachestore's** RocksDB instance
(`RocksCacheStoreDetails::open_db`, same file, ~line 90) has no merge operator registered today.

The idea: store the Pending count as a single derived key per prefix, updated via
`write_batch.merge_cf(cf, key, delta_bytes)` (`+1`/`-1` encoded as the merge operand) instead of
a plain atomic. `BatchPipe::batch()` (`rust/cubestore/cubestore/src/metastore/rocks_store.rs`,
~line 649) returns the raw `WriteBatch`, so this merge call can be added **inside the same
`WriteBatch`** as the actual item mutation (`queue_schema.insert()`/`.update()`/`.delete_row()`
already take a `&mut BatchPipe`) — i.e., co-located with the state transition, not a separate,
forgettable bookkeeping call the way Option A's atomic increment is (currently called
*after* the write completes, per the existing sharding-branch pattern).

This matters for a reason beyond code hygiene: **a plain (non-merge) read-modify-write counter
key would need its own lock to stay correct under concurrent writers** (two concurrent
transitions both reading count=5, both writing count=6, losing an update) — which would
reintroduce serialization, working against any future attempt to shard retrieve-adjacent writes.
Merge operators exist specifically to let RocksDB compose commutative `+1`/`-1` deltas from
concurrent writers without requiring a read-before-write, which is exactly the shape of this
problem.

**Pros**: persists across restarts without a scan-based rebuild; update is embedded in the same
atomic batch as the real mutation (harder to forget); doesn't need an app-level lock even under
future increased write concurrency.
**Cons**: new mechanism for this specific table/database (first real use, even though the
low-level API is proven elsewhere in the fork); needs its own tests around merge-operator
semantics (partial merges, compaction-time behavior, consistent registration across all DB-open
call sites); slightly more upfront implementation effort than Option A.

### Option C (complementary, do regardless of A vs. B): stop materializing the Vec

`count_rows_by_index`'s `get_row_ids_by_index(...).len()` allocates a full `Vec` just to discard
it. Counting via a plain iterator (no collection) would cut real constant-factor overhead. This
does **not** change the O(n) growth that drives the cascade — it would push the threshold out
somewhat, not eliminate it — so it is not a substitute for A or B, just a cheap complementary win.

---

## 6. Drift Safety Analysis (why Option A's "eventually consistent" nature is low-risk here)

Checked directly, not assumed:

- **Every call site that returns `pending` was traced** (`queue_add`, and all branches of
  `queue_retrieve_by_path` — `NotEnoughConcurrency`, `NotFound`, `LockFailed`, `Success`). In every
  case, the count is placed directly into a response struct field and **never conditions any
  control flow**. The actual admission decision inside CubeStore is `active.len() >= allow_concurrency`
  — a completely separate check, backed by the (bounded) Active scan, not the Pending count.
- **Traced through to the JS client too**: the `pending` value becomes `queueSize` in
  `packages/cubejs-query-orchestrator/src/orchestrator/QueryQueue.ts`. Every reference to it is
  inside a `this.logger(...)` call or an event-emission payload — never a branch. (There *is* real
  client-side scheduling logic that depends on active/pending lists —
  `reconcileQueueImpl`'s `toProcessLimit` — but that is fed by a separate `QUEUE LIST` RPC call
  [`getActiveAndToProcess`/`getQueryStageState` in `CubeStoreQueueDriver.ts`], a different,
  already-direct-read code path, not the count field this fix would touch.)
- **Conclusion**: even if a `Pending` atomic counter drifted arbitrarily, the worst case is a
  stale number in a log line or a monitoring dashboard. There is no code path, in Rust or JS,
  where an incorrect Pending count causes an incorrect admission decision, a lost update, or any
  functional bug. This is a meaningfully *lower*-stakes counter than `QueueActiveCounters` (which
  the existing code already treats cautiously — it uses the fast atomic count for a first-pass
  check, then does a real scan as an authoritative "double-check against RocksDB ground truth"
  before actually admitting anything, specifically because it doesn't fully trust the counter
  alone for a decision that matters).
- The one real engineering risk is not "drift" in the abstract, it's **"did every code path that
  changes Pending status remember to update the counter."** That's an ordinary, testable
  discipline problem — write a test analogous to (or literally adapted from) the sharding
  branch's `test_queue_counters_match_ground_truth_after_churn` (concurrent add/retrieve/ack/cancel
  churn, assert the counter matches a fresh scan both before and after a rebuild).

---

## 7. Recommendation and Suggested Next Steps

1. Implement **Option A** first (in-process atomic `QueuePendingCounters`, mirroring
   `QueueActiveCounters`'s API shape: `try_increment`/`decrement`/`get_count`/`rebuild`).
   Wire increment into `queue_add`, decrement into the success paths of `queue_retrieve_by_path`
   and `queue_cancel` (only when the item was still `Pending`), and a rebuild call alongside the
   existing `rebuild_queue_active_counters()` in `spawn_processing_loops`.
2. Replace the `count_rows_by_index(ByPrefixAndStatus(prefix, Pending))` calls in
   `queue_add`/`queue_retrieve_by_path` with reads from the new counter.
3. Do Option C (avoid the `Vec` materialization in `count_rows_by_index`'s general implementation)
   as a cheap, independent win — it's still used elsewhere in the codebase for cases where an
   incremental counter isn't (yet) available.
4. Write a `test_queue_pending_counters_match_ground_truth_after_churn` test analogous to the
   existing Active-counter test.
5. Re-run `benches/cachestore_queue_production_repro.rs` at the same `PODS`/`HOLD_MS`/
   `ALLOW_CONCURRENCY` combinations documented in §3, both before and after the fix, to confirm
   the cascade threshold moves substantially higher (or ideally disappears within the range this
   benchmark can practically test) and to capture new real numbers for whatever write-up follows.
6. Only pursue **Option B** (merge operator) afterward, and only if Option A's drift/discipline
   risk turns out to matter in practice (per §6, not expected) or if there's separate appetite for
   the more architecturally durable version. Don't block the initial fix on it.
7. Consider whether this fix should also apply to the **Active** list scan cost inside
   `queue_retrieve_by_path`'s ground-truth double-check (the "returned `active: Vec<String>` list"
   itself, not just the already-O(1) counter) if profiling after step 5 shows it's now the next
   bottleneck — out of scope for the initial fix, flagged for awareness only.

## 8. Key File References

| File | Relevance |
| --- | --- |
| `rust/cubestore/cubestore/src/cachestore/cache_rocksstore.rs` | `queue_add`, `queue_retrieve_by_path` (the functions to modify) |
| `rust/cubestore/cubestore/src/metastore/rocks_table.rs` | `count_rows_by_index`, `get_row_ids_by_index` (root cause) |
| `rust/cubestore/cubestore/src/metastore/mod.rs` | `meta_store_merge`, `RocksMetaStoreDetails::open_db` (existing merge-operator precedent, Option B reference) |
| `rust/cubestore/cubestore/src/cachestore/queue_active_counters.rs` (on `cubestore-queue-sharding` branch only) | `QueueActiveCounters` — the pattern to mirror for Option A |
| `rust/cubestore/cubestore/benches/cachestore_queue_production_repro.rs` | The repro/validation benchmark (already on this branch) |
| `packages/cubejs-query-orchestrator/src/orchestrator/QueryCache.ts`, `PreAggregations.ts` | Queue prefix construction (§1a) |
| `packages/cubejs-query-orchestrator/src/orchestrator/QueryQueue.ts` | `queueSize`/`toProcessLimit` client-side consumers (§6) |
| `packages/cubejs-cubestore-driver/src/CubeStoreQueueDriver.ts` | `retrieveForProcessing`, `getActiveAndToProcess` (JS-to-CubeStore RPC boundary) |

## 9. Related Work

- `cubestore-queue-sharding` branch / [PR #2](https://github.com/jdaripineni/cube/pull/2): the
  RW-loop sharding work that led to building the benchmark this document relies on. Independent
  of this fix — can land in either order, or neither depends on the other.
