use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};
use cuberockstore::rocksdb::merge_operator::MergeOperands;
use cuberockstore::rocksdb::{Snapshot, WriteBatch};
use std::io::Cursor;

/// Leading tag byte for this module's raw RocksDB keys. Chosen to never collide with
/// `RowKey::to_bytes()` (`metastore/rocks_store.rs`), whose only defined leading bytes are
/// `1..=5` -- see `MetaStoreCacheCompactionFilter::filter` (`cachestore/compaction.rs`), which
/// explicitly allow-lists this tag ahead of its `RowKey::try_from_bytes` parse so compaction
/// never logs a spurious "unable to read key" error for these entries.
pub const QUEUE_PENDING_COUNT_KEY_TAG: u8 = 0xFE;

/// Tracks the number of `Pending` queue items per prefix as a value derived, persisted, and
/// resolved entirely by RocksDB itself via a registered associative merge operator -- so
/// `QUEUE ADD`/`QUEUE RETRIEVE` no longer need to recompute the count via a full RocksDB index
/// scan on every call, *and* the count survives a process restart with no rebuild-from-scan step.
/// See `PENDING_COUNT_SCAN_COST.md` for the full problem writeup and the rationale for this
/// approach (§5).
///
/// This counter is advisory only -- every call site that reads it places the result directly
/// into a response field or a log line, never a control-flow decision (the real
/// concurrency-admission check uses the separately-bounded `Active` list). See
/// `PENDING_COUNT_SCAN_COST.md` section 6 for the full trace of every call site.
///
/// All mutation happens by queuing a `merge` into the *same* `WriteBatch` as the actual queue
/// item mutation (`queue_add`'s insert, `queue_retrieve_by_path`'s status update, etc.) -- so the
/// counter update can never be committed without the real state change, or vice versa, unlike a
/// separate bookkeeping call that could be forgotten independently.
///
/// Known limitation (documented, not fixed by this change): `RocksStore::run_upload`'s
/// incremental per-write log-shipping path (gated behind `CUBESTORE_CACHESTORE_LOG_ENABLED`,
/// default `false`) iterates each `WriteBatch` via `WriteBatchIterator`, whose upstream trait
/// only exposes `put`/`delete` callbacks -- `merge` records are silently not visited by that
/// specific replay path. A periodic full RocksDB checkpoint (`upload_check_point`) is unaffected
/// (it copies actual on-disk SST/WAL files, which already contain fully-resolved merge state),
/// so this only matters for deployments that both enable that incremental log-shipping flag *and*
/// rely on it exclusively (never resyncing from a checkpoint) for cross-replica consistency of
/// this specific counter. Given section 6's drift-safety analysis (this counter never gates a
/// correctness decision), the worst case of this gap is a stale number in a log line on a
/// follower replica, not a functional bug -- but it is a real, non-default-but-real gap this
/// implementation does not close.
#[derive(Debug, Default)]
pub struct QueuePendingCounters;

impl QueuePendingCounters {
    pub fn new() -> Self {
        Self
    }

    fn key(prefix: &str) -> Vec<u8> {
        let mut k = Vec::with_capacity(1 + prefix.len());
        k.push(QUEUE_PENDING_COUNT_KEY_TAG);
        k.extend_from_slice(prefix.as_bytes());
        k
    }

    fn encode_delta(delta: i64) -> Vec<u8> {
        let mut buf = Vec::with_capacity(8);
        buf.write_i64::<BigEndian>(delta).unwrap();
        buf
    }

    /// Current pending count for `prefix` (0 if never seen). Reads through the snapshot passed
    /// to the current write/read operation, so it reflects every previously-committed
    /// increment/decrement for this prefix (RocksDB resolves any unmerged operands at read time
    /// via the registered merge operator -- see `queue_pending_count_merge` below).
    pub fn get_count(&self, snapshot: &Snapshot, prefix: &str) -> u64 {
        snapshot
            .get(Self::key(prefix))
            .ok()
            .flatten()
            .and_then(|v| Cursor::new(v).read_i64::<BigEndian>().ok())
            .map(|v| v.max(0) as u64)
            .unwrap_or(0)
    }

    /// Queue a `+1` merge for `prefix` into `batch` (an item just became `Pending`, i.e. a
    /// genuinely new item was added -- not a duplicate `queue_add` on an existing path). Callers
    /// must read the pre-increment count via `get_count` *before* calling this and compute the
    /// post-increment value themselves for any response field -- the real, authoritative value
    /// isn't resolved until `batch` is committed.
    pub fn increment(&self, batch: &mut WriteBatch, prefix: &str) {
        batch.merge(Self::key(prefix), Self::encode_delta(1));
    }

    /// Queue a `-1` merge for `prefix` into `batch` (an item left `Pending`: it was retrieved, or
    /// cancelled while still `Pending`). The merge function clamps at 0, so a hypothetical missed
    /// increment can't drive the persisted value negative.
    pub fn decrement(&self, batch: &mut WriteBatch, prefix: &str) {
        batch.merge(Self::key(prefix), Self::encode_delta(-1));
    }

    /// Queue a delete-range covering every prefix's counter key. Used by `queue_truncate`, which
    /// wipes the whole `queue_item` table -- these derived keys live outside that table's own
    /// `RowKey` space, so they need their own explicit reset.
    pub fn reset_all(&self, batch: &mut WriteBatch) {
        batch.delete_range(
            vec![QUEUE_PENDING_COUNT_KEY_TAG],
            vec![QUEUE_PENDING_COUNT_KEY_TAG + 1],
        );
    }
}

/// Associative merge function backing `QueuePendingCounters`. Registered via
/// `set_merge_operator_associative` on the cachestore's RocksDB instance
/// (`RocksCacheStoreDetails::open_db`/`open_readonly_db`) -- mirrors the existing
/// `meta_store_merge` precedent in `metastore/mod.rs` (registered there but currently unused),
/// except this one supports signed deltas (metastore's is unsigned-only, add-only) and clamps at
/// a 0 floor since a `Pending` count can never legitimately go negative.
pub fn queue_pending_count_merge(
    _key: &[u8],
    existing_val: Option<&[u8]>,
    operands: &MergeOperands,
) -> Option<Vec<u8>> {
    let mut counter: i64 = existing_val
        .and_then(|v| Cursor::new(v).read_i64::<BigEndian>().ok())
        .unwrap_or(0);

    for op in operands {
        counter += Cursor::new(op).read_i64::<BigEndian>().unwrap_or(0);
    }

    if counter < 0 {
        counter = 0;
    }

    let mut result = Vec::with_capacity(8);
    result.write_i64::<BigEndian>(counter).unwrap();
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `MergeOperands` has no public constructor outside of RocksDB's own C callback path (it
    // wraps raw FFI pointers), so `queue_pending_count_merge` itself can't be unit-tested in
    // isolation the way a plain function could be. It's exercised end-to-end instead, through a
    // real RocksDB instance with the operator registered -- see
    // `cache_rocksstore::tests::test_queue_pending_counters_match_ground_truth_after_churn` and
    // `test_queue_pending_counters_persist_across_restart`.

    #[test]
    fn key_uses_reserved_tag_byte() {
        let k = QueuePendingCounters::key("some_prefix");
        assert_eq!(k[0], QUEUE_PENDING_COUNT_KEY_TAG);
        assert_eq!(&k[1..], b"some_prefix");
    }

    #[test]
    fn encode_delta_round_trips() {
        for delta in [-5_i64, -1, 0, 1, 42] {
            let bytes = QueuePendingCounters::encode_delta(delta);
            assert_eq!(Cursor::new(bytes).read_i64::<BigEndian>().unwrap(), delta);
        }
    }
}
