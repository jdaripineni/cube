use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

/// Tracks the number of `Pending` queue items per prefix using lock-free atomic
/// counters, so `QUEUE ADD`/`QUEUE RETRIEVE` no longer need to recompute the count
/// via a full RocksDB index scan on every call. See `PENDING_COUNT_SCAN_COST.md`
/// for the full problem writeup this fixes.
///
/// All queue writes that touch these counters (`queue_add`, `queue_retrieve_by_path`,
/// `queue_cancel`) are funneled through a single-threaded RW loop
/// (`RocksCacheStore::write_operation_queue`), so there is never more than one writer
/// at a time; `RwLock` here only protects the `HashMap` itself against concurrent
/// readers (e.g. `queue_list`), not against writer-writer races.
///
/// This counter is advisory only -- every call site that reads it places the result
/// directly into a response field or a log line, never a control-flow decision (the
/// real concurrency-admission check uses the separately-bounded `Active` list). See
/// `PENDING_COUNT_SCAN_COST.md` section 6 for the full trace of every call site.
#[derive(Debug, Default)]
pub struct QueuePendingCounters {
    counters: RwLock<HashMap<String, Arc<AtomicU64>>>,
}

impl QueuePendingCounters {
    pub fn new() -> Self {
        Self {
            counters: RwLock::new(HashMap::new()),
        }
    }

    /// Rebuild all counters from a fresh RocksDB scan. Must be called once at startup,
    /// before any queue operation is processed -- not periodic, mirrors the
    /// `cubestore-queue-sharding` branch's `rebuild_queue_active_counters`.
    pub fn rebuild(&self, prefix_counts: HashMap<String, u64>) {
        let mut counters = self.counters.write().unwrap();
        counters.clear();
        for (prefix, count) in prefix_counts {
            counters.insert(prefix, Arc::new(AtomicU64::new(count)));
        }
    }

    /// Increment the pending count for `prefix` (an item just became `Pending`, i.e.
    /// a genuinely new item was added -- not a duplicate `queue_add` on an existing
    /// path). Returns the count *after* incrementing.
    pub fn increment(&self, prefix: &str) -> u64 {
        let counter = self.get_or_create_counter(prefix);
        counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Decrement the pending count for `prefix` (an item left `Pending`: it was
    /// retrieved, or cancelled while still `Pending`). Saturates at 0 instead of
    /// underflowing, so a hypothetical missed increment can't wrap the counter.
    /// Returns the count *after* decrementing.
    pub fn decrement(&self, prefix: &str) -> u64 {
        let counter = self.get_or_create_counter(prefix);
        loop {
            let current = counter.load(Ordering::SeqCst);
            if current == 0 {
                return 0;
            }
            if counter
                .compare_exchange(current, current - 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return current - 1;
            }
        }
    }

    /// Current pending count for `prefix` (0 if the prefix has never been seen).
    pub fn get_count(&self, prefix: &str) -> u64 {
        self.counters
            .read()
            .unwrap()
            .get(prefix)
            .map(|c| c.load(Ordering::SeqCst))
            .unwrap_or(0)
    }

    fn get_or_create_counter(&self, prefix: &str) -> Arc<AtomicU64> {
        {
            let counters = self.counters.read().unwrap();
            if let Some(counter) = counters.get(prefix) {
                return counter.clone();
            }
        }
        let mut counters = self.counters.write().unwrap();
        counters
            .entry(prefix.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn increment_decrement_round_trip() {
        let counters = QueuePendingCounters::new();
        assert_eq!(counters.get_count("p"), 0);
        assert_eq!(counters.increment("p"), 1);
        assert_eq!(counters.increment("p"), 2);
        assert_eq!(counters.get_count("p"), 2);
        counters.decrement("p");
        assert_eq!(counters.get_count("p"), 1);
    }

    #[test]
    fn decrement_saturates_at_zero() {
        let counters = QueuePendingCounters::new();
        counters.decrement("p");
        assert_eq!(counters.get_count("p"), 0);
    }

    #[test]
    fn rebuild_replaces_all_state() {
        let counters = QueuePendingCounters::new();
        counters.increment("stale");
        let mut fresh = HashMap::new();
        fresh.insert("p1".to_string(), 5u64);
        fresh.insert("p2".to_string(), 0u64);
        counters.rebuild(fresh);
        assert_eq!(counters.get_count("stale"), 0);
        assert_eq!(counters.get_count("p1"), 5);
        assert_eq!(counters.get_count("p2"), 0);
    }

    #[test]
    fn separate_prefixes_are_independent() {
        let counters = QueuePendingCounters::new();
        counters.increment("a");
        counters.increment("a");
        counters.increment("b");
        assert_eq!(counters.get_count("a"), 2);
        assert_eq!(counters.get_count("b"), 1);
    }
}
