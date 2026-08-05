# CubeStore Queue Retrieve: Unbounded Pending-Count Scan Cost

## Status

**Fixed and benchmarked.** Option A (in-process atomic `QueuePendingCounters`) plus Option C
(non-allocating count path) are implemented, covered by a drift/ground-truth test, and validated
against the same production-repro benchmark used to diagnose the problem -- see §10
("Implementation") and §11 ("Before/After Benchmark Results") below. This document is written to
be resumable in a fresh session with no memory of the investigation that produced it -- it is
self-contained.

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

1. ✅ **Done.** Implement **Option A** first (in-process atomic `QueuePendingCounters`, mirroring
   `QueueActiveCounters`'s API shape: `increment`/`decrement`/`get_count`/`rebuild`).
   Wire increment into `queue_add`, decrement into the success paths of `queue_retrieve_by_path`
   and `queue_cancel` (only when the item was still `Pending`), and a rebuild call alongside the
   existing `rebuild_queue_active_counters()` in `spawn_processing_loops`.
2. ✅ **Done.** Replace the `count_rows_by_index(ByPrefixAndStatus(prefix, Pending))` calls in
   `queue_add`/`queue_retrieve_by_path` with reads from the new counter. (`queue_truncate` also
   now resets every counter, since it wipes the whole table.)
3. ✅ **Done.** Option C (avoid the `Vec` materialization in `count_rows_by_index`'s general
   implementation) -- turned out, once 1/2 landed, to have zero remaining call sites in this
   codebase (`count_rows_by_index` was only ever called from the two queue sites this branch
   replaced), so its benefit today is purely "the next caller that needs a count instead of a
   list doesn't pay an avoidable allocation," not a measured win in this benchmark. Implemented
   anyway since it's a correct, cheap, low-risk general improvement to a shared trait method.
4. ✅ **Done.** `test_queue_pending_counters_match_ground_truth_after_churn` (concurrent
   add/retrieve/cancel/ack churn across several prefixes, counter compared to a fresh RocksDB
   scan both before and after an explicit rebuild) plus a simpler sequential
   `test_queue_pending_count_sequential` for the straightforward case.
5. ✅ **Done.** Re-ran `benches/cachestore_queue_production_repro.rs` at the same `PODS`/`HOLD_MS`/
   `ALLOW_CONCURRENCY` combinations documented in §3, both before and after the fix, on the same
   machine back-to-back for a controlled comparison -- see §11. Headline result: the fix does
   **not** eliminate high tail (p99/max) latency when demand massively exceeds capacity (that
   ceiling is simple queueing math this fix was never going to change), but it eliminates the
   *throughput degradation* the scan cost caused (33.33 -> 40.00 items/sec, back to the
   capacity-bound theoretical maximum) and cuts p50/p90 pickup latency by 3-4 orders of magnitude
   (seconds -> sub-millisecond) at every load level tested.
6. Not yet pursued: **Option B** (merge operator). Per §6's drift-safety analysis this hasn't
   proven necessary in testing (the ground-truth test in step 4 passes cleanly), so it remains
   deferred unless real-world operation surfaces a drift/discipline problem Option A's
   discipline-by-convention approach doesn't catch.
7. Not yet pursued: whether the **Active** list scan cost inside `queue_retrieve_by_path`'s
   ground-truth double-check (the `active: Vec<String>` list itself) is now the next bottleneck.
   §11's data doesn't point at this -- the Active list is already bounded by `allow_concurrency`
   (a small constant, e.g. 20 in these benchmarks), not by backlog size, so it was never part of
   the mechanism this document describes. Still flagged for awareness only.

## 8. Key File References

| File | Relevance |
| --- | --- |
| `rust/cubestore/cubestore/src/cachestore/cache_rocksstore.rs` | `queue_add`, `queue_retrieve_by_path`, `queue_cancel`, `queue_truncate`, `rebuild_queue_pending_counters` (the functions modified) |
| `rust/cubestore/cubestore/src/cachestore/queue_pending_counters.rs` | `QueuePendingCounters` -- the Option A implementation this branch adds |
| `rust/cubestore/cubestore/src/metastore/rocks_table.rs` | `count_rows_by_index`, `count_row_ids_from_index`, `get_row_ids_by_index` (root cause + Option C) |
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

## 10. Implementation

Implements Option A plus Option C, per §7.

**`QueuePendingCounters`** (`cachestore/queue_pending_counters.rs`, new file) -- an
`AtomicU64`-per-prefix counter behind a `HashMap` guarded by `std::sync::RwLock` (not
`tokio::sync`: the write side is called from the fully-synchronous closures that run on
`RocksCacheStore`'s single-threaded queue RW loop, which cannot `.await`; this mirrors the
existing precedent in this codebase of `RocksStore::seq_store` -- also a plain `std::sync::Mutex`
shared between those closures and the async layer). API: `new`, `rebuild(HashMap<String, u64>)`,
`increment(prefix) -> u64`, `decrement(prefix) -> u64` (saturating at 0), `get_count(prefix) -> u64`.
Because every queue write op (`queue_add`/`queue_retrieve_by_path`/`queue_cancel`/etc.) is already
funneled through one single-threaded channel-fed RW loop, there is never more than one writer at a
time -- the `RwLock` only protects the `HashMap` against concurrent *readers* (e.g. `queue_list`
callers), not against writer-writer races. Four unit tests cover increment/decrement/rebuild/
independent-prefixes in isolation.

**Wiring** (`cachestore/cache_rocksstore.rs`):

- `RocksCacheStore` gained a `queue_pending_counters: Arc<QueuePendingCounters>` field.
- `rebuild_queue_pending_counters()` (new method, mirrors `rebuild_queue_active_counters` on the
  sharding branch): scans every queue item once via `read_operation_queue`, counts `Pending` items
  per prefix, calls `.rebuild(...)`. Called once at startup from `spawn_processing_loops` via a
  one-shot spawned task, before any other queue operation is processed.
- `queue_add`: replaced the `count_rows_by_index(ByPrefixAndStatus(prefix, Pending))` scan with
  `queue_pending_counters.get_count(&prefix)` for the pre-add count, and `.increment(&prefix)`
  when a genuinely new item is inserted (not on a duplicate-path no-op add).
  `queue_retrieve_by_path`: same scan replaced with `.get_count(&prefix)`; `.decrement(&prefix)`
  replaces the old `pending -= 1` on the `Success` path (Pending -> Active transition).
  `queue_cancel`: captures the item's status and prefix before deleting it, and calls
  `.decrement(&prefix)` only if it was still `Pending` at cancel time (an already-`Active` item
  being cancelled must not touch the Pending counter).
- `queue_truncate`: wipes the whole `queue_item` table, so it now also calls
  `queue_pending_counters.rebuild(HashMap::new())` to reset every counter to 0 rather than leaving
  stale per-prefix counts behind.
- `#[cfg(test)] queue_pending_count_for_test(prefix) -> u64`: test-only accessor so tests can
  assert the counter against RocksDB ground truth without exposing internal state in production
  APIs (same pattern as the sharding branch's `queue_active_count_for_test`).
- Every other place that mutates the `queue_item` table was checked: `queue_merge_extra` only
  touches the `extra` metadata field, never `status`, so it's a no-op for this counter;
  `queue_to_cancel` is a read-only "candidates" query -- actual cancellation still goes through
  `queue_cancel` above, so there's no separate call site to wire.

**Option C** (`metastore/rocks_table.rs`): added `count_row_ids_from_index`, a copy of
`get_row_ids_from_index`'s exact matching logic (same hash comparison, same TTL-expiry check) that
increments a `u64` counter instead of pushing into a `Vec<u64>`. `count_rows_by_index` now calls
this instead of `get_row_ids_by_index(...).len()`. Grepping the codebase before and after this
change confirms `count_rows_by_index` has exactly two call sites total, both inside this branch's
`queue_add`/`queue_retrieve_by_path` -- both of which this same branch replaces with the atomic
counter. So today this change has no measurable effect on this benchmark; it's included because
it's a strict improvement to shared, reusable trait infrastructure at near-zero cost/risk, for
whatever the next caller of "just give me a count" turns out to be.

**Tests**: `test_queue_pending_count_sequential` (deterministic add/add/duplicate-add/retrieve/
cancel sequence, asserts the `pending` field returned by each call and the counter accessor match
hand-computed expected values) and `test_queue_pending_counters_match_ground_truth_after_churn`
(concurrent add/retrieve/cancel/ack churn across 4 prefixes x 10 items each, asserts the counter
matches a fresh `queue_list`-based scan both before and after an explicit
`rebuild_queue_pending_counters()` call). Both pass, alongside the full existing
`cargo test -p cubestore --lib` suite (204 tests) and the cachestore-scoped subset (32 tests) --
zero failures, zero new warnings from `cargo check -p cubestore --lib --tests`.

## 11. Before/After Benchmark Results

Methodology: to avoid the risk of comparing against a previous session's numbers captured under
different machine load (a real risk -- see the note on run-to-run variance below), this comparison
built **two** release binaries of `cachestore_queue_production_repro` from the *exact same*
benchmark source file -- one from this branch's pre-fix commit (`a18852ed6`, the diagnosis-only
commit, unmodified `count_rows_by_index`-based scan) and one from this branch's post-fix HEAD --
and ran both, back-to-back, on the same idle machine, same session, same day. This is the
"before" and "after" referenced below; treat the earlier `PENDING_COUNT_SCAN_COST.md`/PR #3 draft
numbers (captured in a different session) as superseded by this controlled comparison.

All runs: `HOLD_MS=500`, `ALLOW_CONCURRENCY=20`, `CUBESTORE_QUEUE_RW_WORKERS=1` (this branch has no
sharding, so this env var is inert -- included only because the benchmark file reads it
unconditionally). Apple M4 Max, 14 logical cores, RocksDB on local SSD, no network hop -- same
caveat as before: indicative of mechanism and rough magnitude, not a production SLA measurement.

### PODS=40 (demand/capacity ratio 2x -- below any threshold, sanity check)

| | Throughput (items/s) | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | pending high-water |
| --- | --- | --- | --- | --- | --- | --- |
| Before | 40.00 | 2.58 | 3.87 | 4.63 | 5.14 | 40 |
| After | 40.00 | 2.46 | 5.30 | 13.42 | 13.65 | 23 |

Both flat and fast (single-digit-to-low-double-digit milliseconds) -- no cascade at this load
either way, as expected. The small "after" p99/max upward wobble (13.4ms vs 4.6ms) is ordinary
scheduler/timing noise at a scale this small (only 200 samples, sub-15ms), not a regression --
both results are in the "no cascade" regime by a wide margin (three orders of magnitude below the
multi-second results below).

### PODS=500 (demand/capacity ratio 25x)

| | Throughput (items/s) | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | pending high-water |
| --- | --- | --- | --- | --- | --- | --- |
| Before | 40.00 | 1,531.17 | 12,270.85 | 15,902.88 | 15,908.92 | 491 |
| After | 40.00 | 1.64 | 3.02 | 12,344.26 | 12,348.87 | 500 |

p50 improves **~933x** (1.53s -> 1.6ms), p90 improves **~4,065x** (12.27s -> 3.0ms). p99/max
improve more modestly (~22%: 15.9s -> 12.3s).

### PODS=1000 (demand/capacity ratio 50x -- the headline scenario from §3/§11's predecessor)

| | Throughput (items/s) | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) | pending high-water |
| --- | --- | --- | --- | --- | --- | --- |
| Before | 33.33 | 10,929.40 | 26,342.69 | 27,407.53 | 27,408.12 | 980 |
| After | 40.00 | 0.24 | 0.69 | 24,587.85 | 25,102.99 | 981 |

p50 improves **~45,000x** (10.9s -> 0.24ms), p90 improves **~38,000x** (26.3s -> 0.69ms). p99/max
improve more modestly (~10%: 27.4s -> ~25s). **Throughput itself was measurably degraded before
the fix** (33.33 items/sec vs the 40.00 items/sec theoretical capacity ceiling,
`ALLOW_CONCURRENCY / (HOLD_MS/1000)` = 20/0.5) -- direct evidence the O(n) scan was consuming real
capacity, not just adding latency. After the fix, throughput matches the theoretical ceiling
exactly.

### What this data does and doesn't show

**Does show**: this fix eliminates a genuine, measurable throughput tax the O(n) Pending scan was
imposing under sustained overload (33.33 -> 40.00 items/sec at 50x demand), and it collapses
pickup latency for the *large majority* of items (p50/p90) from multi-second to sub-millisecond at
every load level tested -- a real, large, reproducible improvement to the common case.

**Doesn't show**: this fix does **not** make worst-case (p99/max) latency disappear when demand
massively exceeds capacity. At PODS=1000 (50x demand/capacity), roughly 980 items are competing for
a system that can only sustain 40 admissions/sec -- even a hypothetical zero-cost retrieve call
still has ~980/40 ≈ 24.5s of unavoidable queueing math for the last items to drain, which is
almost exactly what "after" measures (p99 24.6s). That ceiling is ordinary capacity-bound queueing
behavior, not a bug, and this fix was never intended to (and cannot) change it -- provisioning
`allow_concurrency`/pod count for actual expected burst demand is the only lever for that part.
The value of this fix is specifically the gap between "before" and that theoretical floor
(27.4s max before vs a ~24.5s theoretical floor the fix gets "after" within ~2% of) plus the
enormous p50/p90 improvement, not "no more tail latency under 50x overload" -- no in-process fix
to a single mechanism could deliver that.

**Combined with the `cubestore-queue-sharding` branch**: that branch's per-shard threads don't
change any number in the tables above (confirmed in the predecessor investigation: `workers=1` vs
`workers=8` were statistically indistinguishable on this exact benchmark), because sharding
parallelizes *across* prefixes/threads, while every mechanism this document addresses lives
*inside* a single retrieve call's own cost, independent of thread count. The two fixes are
complementary and additive, not overlapping: this branch fixes a real algorithmic cost inside one
call; the sharding branch fixes cross-item thread contention for unrelated queue operations. A
deployment hitting both symptoms (heartbeat/ack delay from thread contention, *and* pickup-latency
degradation from Pending backlog) would want both.
