use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Tracks active queue item counts per prefix using lock-free atomic counters.
/// This eliminates the need to scan the RocksDB index on every QUEUE RETRIEVE.
#[derive(Debug)]
pub struct QueueActiveCounters {
    /// Prefix → active count (AtomicU32 for lock-free reads and CAS updates)
    counters: tokio::sync::RwLock<HashMap<String, Arc<AtomicU32>>>,
    /// Per-prefix mutex to serialize RETRIEVE operations within the same prefix.
    /// This is necessary because RETRIEVE must atomically check concurrency + mark active.
    /// Different prefixes can RETRIEVE in parallel.
    retrieve_locks: tokio::sync::RwLock<HashMap<String, Arc<Mutex<()>>>>,
    /// Monotonically increasing operation counter for round-robin scheduling.
    op_counter: AtomicU64,
}

impl QueueActiveCounters {
    pub fn new() -> Self {
        Self {
            counters: tokio::sync::RwLock::new(HashMap::new()),
            retrieve_locks: tokio::sync::RwLock::new(HashMap::new()),
            op_counter: AtomicU64::new(0),
        }
    }

    /// Rebuild counters from RocksDB state at startup.
    pub async fn rebuild(&self, prefix_counts: HashMap<String, u32>) {
        let mut counters = self.counters.write().await;
        counters.clear();
        for (prefix, count) in prefix_counts {
            counters.insert(prefix, Arc::new(AtomicU32::new(count)));
        }
    }

    /// Try to increment the active count for a prefix. Returns Ok(previous_count) if
    /// the increment succeeded (previous < limit), or Err(current_count) if at limit.
    pub async fn try_increment(&self, prefix: &str, limit: u32) -> Result<u32, u32> {
        let counter = self.get_or_create_counter(prefix).await;

        // CAS loop to atomically check-and-increment
        loop {
            let current = counter.load(Ordering::SeqCst);
            if current >= limit {
                return Err(current);
            }
            match counter.compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(prev) => return Ok(prev),
                Err(_) => continue, // Retry CAS
            }
        }
    }

    /// Decrement the active count (called on ACK or cancel).
    pub async fn decrement(&self, prefix: &str) {
        let counter = self.get_or_create_counter(prefix).await;
        // Saturating subtract to avoid underflow
        loop {
            let current = counter.load(Ordering::SeqCst);
            if current == 0 {
                return;
            }
            match counter.compare_exchange(current, current - 1, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return,
                Err(_) => continue,
            }
        }
    }

    /// Get current active count for a prefix.
    pub async fn get_count(&self, prefix: &str) -> u32 {
        let counters = self.counters.read().await;
        counters
            .get(prefix)
            .map(|c| c.load(Ordering::SeqCst))
            .unwrap_or(0)
    }

    /// Get the per-prefix retrieve lock (for serializing RETRIEVE within same prefix).
    pub async fn get_retrieve_lock(&self, prefix: &str) -> Arc<Mutex<()>> {
        // Fast path: check if lock exists
        {
            let locks = self.retrieve_locks.read().await;
            if let Some(lock) = locks.get(prefix) {
                return lock.clone();
            }
        }
        // Slow path: create lock
        let mut locks = self.retrieve_locks.write().await;
        locks
            .entry(prefix.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Get a monotonically increasing operation counter for round-robin scheduling.
    pub fn next_op_id(&self) -> u64 {
        self.op_counter.fetch_add(1, Ordering::Relaxed)
    }

    async fn get_or_create_counter(&self, prefix: &str) -> Arc<AtomicU32> {
        // Fast path: counter exists
        {
            let counters = self.counters.read().await;
            if let Some(counter) = counters.get(prefix) {
                return counter.clone();
            }
        }
        // Slow path: create counter
        let mut counters = self.counters.write().await;
        counters
            .entry(prefix.to_string())
            .or_insert_with(|| Arc::new(AtomicU32::new(0)))
            .clone()
    }
}
