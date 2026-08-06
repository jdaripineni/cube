# CubeStore Queue Retrieve: Unbounded Pending-Count Scan Cost

## Status

**Fixed and benchmarked.** `queue_retrieve_by_path`/`queue_add` no longer scan RocksDB to compute
a queue prefix's `Pending`-item count on every call; the count is now maintained as a value
derived, persisted, and resolved entirely by RocksDB itself via a registered associative merge
operator (§7 "Implementation"). §10 has a benchmark comparing this fix against the unmodified
pre-fix code, run on the same machine, same session. This document is written to be resumable in
a fresh session with no memory of the investigation that produced it -- it is self-contained.

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

## 5. The Fix: A RocksDB Merge-Operator-Backed Counter

Replace the O(n) scan with a `Pending`-item count per prefix that is **derived, persisted, and
resolved entirely by RocksDB itself**, via a registered associative merge operator, rather than
recomputed from scratch on every call.

This codebase already has working associative-merge-operator infrastructure — see
`meta_store_merge` in `rust/cubestore/cubestore/src/metastore/mod.rs` (~line 1247), a
`u64` accumulator registered via `opts.set_merge_operator_associative(...)` for the **metastore's**
RocksDB instance (`RocksMetaStoreDetails::open_db`). It appears currently unused/vestigial (no
`.merge()`/`.merge_cf()` call sites found anywhere in the metastore code), but it proves the
mechanism works in this exact fork. The **cachestore's** RocksDB instance
(`RocksCacheStoreDetails::open_db`, same file, ~line 90) had no merge operator registered before
this fix.

The approach: store the Pending count as a single derived key per prefix, updated via
`write_batch.merge(key, delta_bytes)` (`+1`/`-1` encoded as the merge operand) inside the **same
`WriteBatch`** as the actual item mutation (`queue_schema.insert()`/`.update()`/`.delete_row()`
already take a `&mut BatchPipe`, whose `.batch()` returns the raw `WriteBatch` --
`rust/cubestore/cubestore/src/metastore/rocks_store.rs`, ~line 649) — i.e., co-located with the
state transition, not a separate, forgettable bookkeeping call.

This matters for a reason beyond code hygiene: **a plain (non-merge) read-modify-write counter
key would need its own lock to stay correct under concurrent writers** (two concurrent
transitions both reading count=5, both writing count=6, losing an update) — which would
reintroduce serialization, working against any future attempt to shard retrieve-adjacent writes.
Merge operators exist specifically to let RocksDB compose commutative `+1`/`-1` deltas from
concurrent writers without requiring a read-before-write, which is exactly the shape of this
problem. It also persists across restarts with no scan-based rebuild step needed, and the update
is embedded in the same atomic batch as the real mutation, so it can't be committed without the
state transition it tracks (or vice versa) -- see §7 for the actual implementation.

### Complementary win: stop materializing the `Vec` in `count_rows_by_index`

`count_rows_by_index`'s general implementation (`get_row_ids_by_index(...).len()`) allocates a
full `Vec` just to discard it. Counting via a plain iterator (no collection) cuts real
constant-factor overhead for any future caller that needs a count instead of a list. This doesn't
change the underlying O(n) growth by itself (it isn't what fixes the cascade), but it's a cheap,
correct, low-risk improvement to shared trait infrastructure, done alongside the real fix. See §7.

---

## 6. Drift Safety Analysis (why an eventually-resolved Pending count is low-risk here)

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
- **Conclusion**: even if this counter somehow drifted, the worst case is a stale number in a log
  line or a monitoring dashboard. There is no code path, in Rust or JS, where an incorrect Pending
  count causes an incorrect admission decision, a lost update, or any functional bug. This is a
  meaningfully *lower*-stakes counter than the sharding branch's `QueueActiveCounters` (which the
  existing code already treats cautiously — it uses a fast atomic count for a first-pass check,
  then does a real scan as an authoritative "double-check against RocksDB ground truth" before
  actually admitting anything, specifically because it doesn't fully trust the counter alone for a
  decision that matters).
- The one real engineering risk is not "drift" in the abstract, it's **"did every code path that
  changes Pending status remember to queue the merge."** That's an ordinary, testable discipline
  problem, made easier by construction here since the merge is queued into the *same write batch*
  as the real mutation (§7) rather than a separate call that could be forgotten independently --
  and it's covered by `test_queue_pending_counters_match_ground_truth_after_churn` (concurrent
  add/retrieve/ack/cancel churn, counter compared against a fresh RocksDB scan).

---

## 7. Implementation

**`QueuePendingCounters`** (`cachestore/queue_pending_counters.rs`, new file) is a zero-field unit
struct -- all state lives in RocksDB itself, not in process memory:

- **Key encoding**: each prefix's count is a raw key `[0xFE] ++ prefix_bytes`. The `0xFE` leading
  tag is chosen to never collide with `RowKey::to_bytes()` (`metastore/rocks_store.rs`), whose only
  defined leading bytes are `1..=5`.
- **`increment(batch: &mut WriteBatch, prefix)`** / **`decrement(...)`**: queue a `+1`/`-1` merge
  operand (i64, big-endian) into the **same** `WriteBatch` as the real queue-item mutation --
  `queue_add`'s insert, `queue_retrieve_by_path`'s status update, `queue_cancel`'s delete.
- **`get_count(snapshot: &Snapshot, prefix)`**: a plain `snapshot.get(key)` -- RocksDB itself
  resolves any not-yet-compacted merge operands against the base value at read time, standard
  behavior for `set_merge_operator_associative`.
- **`reset_all(batch: &mut WriteBatch)`**: a `delete_range` over the whole `0xFE` key range, called
  by `queue_truncate` (in the same batch as the table wipe) since these keys live outside the
  `queue_item` table's own `RowKey` space and wouldn't otherwise be cleared by it.
- **The merge function** (`queue_pending_count_merge`, associative, registered via
  `set_merge_operator_associative` on both `RocksCacheStoreDetails::open_db` and
  `open_readonly_db`): sums the existing value and all pending i64 operands, clamping the result at
  a 0 floor. Mirrors the existing `meta_store_merge` precedent in `metastore/mod.rs` (registered
  there but with zero real callers today), except that one is unsigned/add-only -- this one needed
  signed deltas to support decrement.
- **Compaction filter**: `MetaStoreCacheCompactionFilter::filter` (`cachestore/compaction.rs`) now
  allow-lists the `0xFE` tag before its `RowKey::try_from_bytes` parse, so it doesn't log a spurious
  "unable to read key" error for every one of these entries on every compaction pass.

**Wiring** (`cachestore/cache_rocksstore.rs`):

- `RocksCacheStore` gained a `queue_pending_counters: Arc<QueuePendingCounters>` field.
- `queue_add`/`queue_retrieve_by_path` read the pre-mutation count via
  `get_count(db_ref.snapshot, ...)`, compute the response's post-mutation value themselves
  (`pending + 1` / `pending.saturating_sub(1)`) exactly the way the *original* pre-fix scan-based
  code already did, and separately queue the real `increment`/`decrement` merge into the batch --
  the merge isn't resolved into ground truth until the batch commits, so the response value is
  computed rather than re-read.
- `queue_cancel`: captures the item's status and prefix before deleting it, and calls
  `.decrement(&prefix)` only if it was still `Pending` at cancel time (an already-`Active` item
  being cancelled must not touch the Pending counter).
- `queue_truncate`: wipes the whole `queue_item` table, and now also calls `reset_all` in the same
  batch, so it can't leave stale per-prefix counts behind.
- No startup rebuild step exists or is needed -- the persisted value is already correct the moment
  the database opens. Proven directly by `test_queue_pending_counters_persist_across_restart`,
  which adds items, retrieves one, drops the `RocksCacheStore`, and reopens a fresh one at the same
  on-disk path (via the existing `prepare_test_cachestore_impl` helper) -- the counter is
  immediately correct with no rebuild call anywhere.
- Every other place that mutates the `queue_item` table was checked: `queue_merge_extra` only
  touches the `extra` metadata field, never `status`, so it's a no-op for this counter;
  `queue_to_cancel` is a read-only "candidates" query -- actual cancellation still goes through
  `queue_cancel` above, so there's no separate call site to wire.

**Complementary win** (`metastore/rocks_table.rs`): added `count_row_ids_from_index`, a copy of
`get_row_ids_from_index`'s exact matching logic (same hash comparison, same TTL-expiry check) that
increments a `u64` counter instead of pushing into a `Vec<u64>`. `count_rows_by_index` now calls
this instead of `get_row_ids_by_index(...).len()`. Grepping the codebase confirms
`count_rows_by_index` has exactly two call sites total, both inside `queue_add`/
`queue_retrieve_by_path` -- both of which this fix replaces with the merge-operator counter. So
today this change has no measurable effect on the benchmark below; it's included because it's a
strict improvement to shared, reusable trait infrastructure at near-zero cost/risk, for whatever
the next caller of "just give me a count" turns out to be.

**Known, documented limitation** (not fixed by this change): `RocksStore::run_upload`'s
incremental per-write log-shipping path (gated behind `CUBESTORE_CACHESTORE_LOG_ENABLED`,
**default `false`**) iterates each committed `WriteBatch` via the `WriteBatchIterator` trait from
the underlying `rust-rocksdb` binding used in this fork, which exposes only `put`/`delete`
callbacks -- no `merge` hook exists in that trait at all. That means this specific replication
path silently does not carry merge records to a follower. A periodic full RocksDB checkpoint
(`upload_check_point`) is unaffected, since it copies the actual on-disk SST/WAL files, which
already contain fully-resolved state regardless of how it got there. Per §6's drift-safety
analysis (this counter never gates a correctness decision anywhere), the worst-case impact of this
gap is a stale number in a log line on a follower replica that both (a) has that non-default flag
enabled and (b) never resyncs from a checkpoint -- not a functional bug, but a real gap this
implementation does not close. Flagged here rather than silently accepted.

**Tests**: `test_queue_pending_count_sequential` (deterministic add/add/duplicate-add/retrieve/
cancel sequence, asserts the `pending` field returned by each call and the counter accessor match
hand-computed expected values), `test_queue_pending_counters_match_ground_truth_after_churn`
(concurrent add/retrieve/cancel/ack churn across 4 prefixes x 10 items each, counter compared
against a fresh `queue_list`-based scan), and `test_queue_pending_counters_persist_across_restart`
(described above). All pass, alongside the full existing `cargo test -p cubestore --lib` suite
(203 tests) -- zero failures, zero new warnings from `cargo check -p cubestore --lib --tests` or
`cargo fmt -p cubestore -- --check`.

## 8. Key File References

| File | Relevance |
| --- | --- |
| `rust/cubestore/cubestore/src/cachestore/cache_rocksstore.rs` | `queue_add`, `queue_retrieve_by_path`, `queue_cancel`, `queue_truncate`, `RocksCacheStoreDetails::open_db`/`open_readonly_db` (merge operator registration) |
| `rust/cubestore/cubestore/src/cachestore/queue_pending_counters.rs` | `QueuePendingCounters` + `queue_pending_count_merge` -- the implementation (§7) |
| `rust/cubestore/cubestore/src/cachestore/compaction.rs` | `MetaStoreCacheCompactionFilter::filter` -- allow-lists the `0xFE` counter-key tag (§7) |
| `rust/cubestore/cubestore/src/metastore/rocks_table.rs` | `count_rows_by_index`, `count_row_ids_from_index`, `get_row_ids_by_index` (root cause + the complementary win) |
| `rust/cubestore/cubestore/src/metastore/mod.rs` | `meta_store_merge`, `RocksMetaStoreDetails::open_db` (the merge-operator precedent this fix's own operator mirrors) |
| `rust/cubestore/cubestore/benches/cachestore_queue_production_repro.rs` | The repro/validation benchmark (already on this branch) |
| `packages/cubejs-query-orchestrator/src/orchestrator/QueryCache.ts`, `PreAggregations.ts` | Queue prefix construction (§1a) |
| `packages/cubejs-query-orchestrator/src/orchestrator/QueryQueue.ts` | `queueSize`/`toProcessLimit` client-side consumers (§6) |
| `packages/cubejs-cubestore-driver/src/CubeStoreQueueDriver.ts` | `retrieveForProcessing`, `getActiveAndToProcess` (JS-to-CubeStore RPC boundary) |

## 9. Related Work

- `cubestore-queue-sharding` branch / [PR #2](https://github.com/jdaripineni/cube/pull/2): the
  RW-loop sharding work that led to building the benchmark this document relies on. Independent
  of this fix — can land in either order, or neither depends on the other.

## 10. Benchmark Results: No Optimization vs. the Fix

Methodology: two release binaries of the *identical* `cachestore_queue_production_repro.rs`
benchmark file (including the p75/p95 percentiles added in this round) -- one built from this
branch's pre-fix commit (`a18852ed6`, unmodified `count_rows_by_index`-based scan), one from the
current HEAD -- run back-to-back on the same idle machine, same session. `HOLD_MS=500`,
`ALLOW_CONCURRENCY=20`, `CUBESTORE_QUEUE_RW_WORKERS=1` (this branch has no sharding, so this env
var is inert -- included only because the benchmark file reads it unconditionally). Apple M4 Max,
14 logical cores, RocksDB on local SSD, no network hop -- indicative of mechanism and rough
magnitude, not a production SLA measurement.

### PODS=40 (2x demand/capacity -- sanity check)

| | Throughput | p50 | p75 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| No optimization | 40.00/s | 1.89ms | 2.49ms | 3.06ms | 3.41ms | 4.00ms | 4.16ms |
| The fix | 40.00/s | 2.82ms | 3.19ms | 3.73ms | 3.97ms | 4.12ms | 4.59ms |

Both flat and fast, no cascade either way -- as expected, well below any threshold. The small
spread here is ordinary scheduler noise at single-digit-millisecond scale, not a meaningful
difference.

### PODS=500 (25x demand/capacity, 3 runs per arm)

| Arm | Run | Throughput | p50 | p75 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| No optimization | 1 | 40.00/s | 2.10ms | 8,680ms | 12,319ms | 12,845ms | 13,354ms | 13,855ms |
| No optimization | 2 | 40.00/s | 1.63ms | 9,204ms | 12,336ms | 13,368ms | 13,887ms | 13,888ms |
| No optimization | 3 | 40.00/s | 2.10ms | 4.31ms | 12,311ms | 12,851ms | 13,359ms | 13,367ms |
| The fix | 1 | 40.00/s | 1.43ms | 1.70ms | 7,694ms | 10,292ms | 12,355ms | 12,875ms |
| The fix | 2 | 40.00/s | 0.93ms | 2.17ms | 10,290ms | 12,341ms | 12,895ms | 13,410ms |
| The fix | 3 | 40.00/s | 1.26ms | 1,529ms | 9,204ms | 11,251ms | 13,838ms | 14,859ms |

### PODS=1000 (50x demand/capacity, 3 runs per arm)

| Arm | Run | Throughput | p50 | p75 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| No optimization | 1 | 33.33/s | 13,579ms | 18,178ms | 22,189ms | 24,306ms | 25,359ms | 25,876ms |
| No optimization | 2 | 35.00/s | 14,220ms | 21,433ms | 24,992ms | 25,945ms | 27,544ms | 27,864ms |
| No optimization | 3 | 36.67/s | 14,094ms | 21,225ms | 24,895ms | 25,897ms | 26,465ms | 27,502ms |
| The fix | 1 | 40.00/s | 1.46ms | 1.66ms | 1.81ms | 1.87ms | 23,554ms | 25,105ms |
| The fix | 2 | 40.00/s | 0.44ms | 19,425ms | 23,558ms | 25,123ms | 25,635ms | 26,138ms |
| The fix | 3 | 40.00/s | 0.66ms | 20,962ms | 25,090ms | 25,618ms | 26,153ms | 26,166ms |

### What this data shows

**Reliable, large wins, every run:**

- **Throughput**: the fix hits the 40.00/s theoretical capacity ceiling in **all 7 runs** across
  both load levels. "No optimization" degrades below the ceiling in **all 3** PODS=1000 runs
  (33.33-36.67/s) -- direct, repeated evidence the O(n) Pending scan consumes real capacity, not
  just adds latency, once demand sustained-exceeds capacity by 50x.
- **p50 (median request)**: the fix is sub-3ms in **all 7** PODS=500/1000 runs (range
  0.44-2.82ms across every load level tested). "No optimization" is sub-3ms only when *not*
  cascading (PODS=40, PODS=500 run 3's p50) and otherwise **13,500-14,200ms** at PODS=1000, every
  single run -- a 4-5 order of magnitude, highly reproducible difference for the typical request.

**What doesn't reliably change:** tail latency (p90+) at 25-50x sustained demand/capacity is
bistable *regardless of the fix* -- e.g. at PODS=1000, the fix's run 1 stays fast through p95
(1.87ms) and only degrades at p99, while runs 2-3 already show multi-second latency by p75. This
matches the closed-loop mechanism below: which specific competing requests get admitted early vs.
late is decided by fine-grained OS/tokio task-scheduling interleaving under sustained contention,
not by anything this fix's counter implementation controls.

**Why this bistability happens, and what it does and doesn't mean:** this benchmark is a
*closed-loop* workload -- `PODS` tasks that each always have exactly one item in flight (add →
wait → hold → ack → immediately add again), maintaining *constant* demand for the entire
measurement window rather than a bursty, mostly-idle pattern. A monitor trace of a cascading run
shows why: `pending` sits pinned at `PODS - allow_concurrency` (e.g. 480 at PODS=500) for the
*entire* recording window, only starting to drain once pods hit `run_deadline` and stop
resubmitting. Because 500 (or 1000) pods are simultaneously polling for admission against a
20-slot ceiling for the whole window, which specific pods' polls happen to land on the
single-threaded RW-loop's channel right as a slot frees is effectively decided by that scheduling
interleaving -- not by the Pending-count fix. That's a genuinely different, unaddressed question
(fairness/ordering of admission among competing `Pending` items for the same prefix) from the one
this fix targets (the O(n) scan cost of *computing* the Pending count) -- flagged for awareness,
out of scope here.

**A caveat on reading these percentiles as "typical request experience": don't.** Because this is
a sustained closed-loop overload (all `PODS` tasks continuously competing, for the whole window,
against a fixed 20-slot ceiling), a large fraction of concurrent participants queueing for a long
time during that window is *real queueing math under 25-50x sustained demand*, not a benchmark
artifact -- basic queueing theory (utilization `ρ = demand/capacity ≫ 1`, sustained) predicts
exactly this: most competitors wait a long time, not just a rare tail. A larger sample size (more
total requests) would not push this into a p99.9-only phenomenon, because it isn't a sampling
precision problem -- percentiles describe the underlying distribution, and a bigger `n` just
estimates the *same* distribution more precisely, it doesn't shrink the bad fraction.

The production symptom this fix addresses was reported as *intermittent* spikes, not 5+ seconds
of sustained 25-50x overload. Under a genuinely intermittent demand pattern (mostly at or under
capacity, with brief occasional bursts), you would expect only the requests that happen to land
during a brief burst to be affected -- a small fraction of *total* traffic measured over a long
window, much closer to a "p50-p95 fine, only the extreme tail degrades" shape. **This benchmark
does not model that.** It is a sustained-overload stress test, useful for finding the mechanism
and the cascade threshold (which is exactly what it was built for, per §3), not a faithful
reproduction of production traffic shape. Read every percentile table in this section as "what
happens under sustained 25-50x overload for the whole measurement window" -- a valid and useful
worst-case characterization -- not as "the percentile distribution real production traffic would
see." Building a dedicated intermittent/bursty-demand benchmark to validate the latter more
directly was considered and explicitly deferred (not enough signal yet that it's needed beyond
what's already established here) -- flagged as a real, known gap rather than silently assumed
away.

At PODS=1000, roughly 980 items are competing for a system that can only sustain 40
admissions/sec -- even a hypothetical zero-cost retrieve call still has ~980/40 ≈ 24.5s of
unavoidable queueing math for the last items to drain, matching what every cascading run's max
measures (25.1-27.9s across every PODS=1000 run in both arms). That ceiling is ordinary
capacity-bound queueing behavior, not a bug, and this fix was never
intended to (and cannot) change it -- provisioning `allow_concurrency`/pod count for actual
expected burst demand is the only lever for that part. The value of this fix is specifically
eliminating the throughput degradation and fixing the *typical* (p50) case by 4-5 orders of
magnitude, not "no more tail latency under 25-50x sustained overload" -- no in-process fix to a
single mechanism could deliver that.

**Combined with the `cubestore-queue-sharding` branch**: that branch's per-shard threads don't
change any number in the tables above (confirmed in the predecessor investigation: `workers=1` vs
`workers=8` were statistically indistinguishable on this exact benchmark), because sharding
parallelizes *across* prefixes/threads, while every mechanism this document addresses lives
*inside* a single retrieve call's own cost, independent of thread count. The two fixes are
complementary and additive, not overlapping: this branch fixes a real algorithmic cost inside one
call; the sharding branch fixes cross-item thread contention for unrelated queue operations. A
deployment hitting both symptoms (heartbeat/ack delay from thread contention, *and*
pickup-latency degradation from Pending backlog) would want both.
