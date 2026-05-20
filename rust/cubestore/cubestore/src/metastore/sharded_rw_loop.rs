use crate::metastore::rocks_store::RocksStoreRWLoopFn;
use crate::CubeError;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// A sharded write execution pool that distributes operations across N worker threads.
/// Operations are routed by a caller-supplied key hash, ensuring operations on the same
/// key execute sequentially while operations on different keys execute in parallel.
#[derive(Debug, Clone)]
pub struct ShardedRocksStoreRWLoop {
    name: &'static str,
    shards: Vec<tokio::sync::mpsc::Sender<RocksStoreRWLoopFn>>,
    num_shards: usize,
}

impl ShardedRocksStoreRWLoop {
    pub fn new(store_name: &'static str, name: &'static str, num_shards: usize) -> Self {
        let num_shards = num_shards.max(1);
        let mut shards = Vec::with_capacity(num_shards);

        for i in 0..num_shards {
            let (tx, mut rx) = tokio::sync::mpsc::channel::<RocksStoreRWLoopFn>(32_768);

            let thread_name = format!("{}-{}-rwloop-{}", store_name, name, i);
            std::thread::Builder::new()
                .name(thread_name.clone())
                .spawn(move || loop {
                    if let Some(fun) = rx.blocking_recv() {
                        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(fun)) {
                            Err(panic_payload) => {
                                let restore_error = CubeError::from_panic_payload(panic_payload);
                                log::error!(
                                    "Panic during sharded rw loop execution ({}): {}",
                                    thread_name,
                                    restore_error
                                );
                            }
                            Ok(res) => {
                                if let Err(e) = res {
                                    log::error!(
                                        "Error during sharded rw loop execution ({}): {}",
                                        thread_name,
                                        e
                                    );
                                }
                            }
                        }
                    } else {
                        return;
                    }
                })
                .unwrap_or_else(|_| {
                    panic!(
                        "Failed to spawn ShardedRWLoop thread for store '{}', name '{}', shard {}",
                        store_name, name, i
                    )
                });

            shards.push(tx);
        }

        Self {
            name,
            shards,
            num_shards,
        }
    }

    /// Schedule an operation on a specific shard determined by the routing key.
    /// Operations with the same routing key execute sequentially; different keys may run in parallel.
    pub async fn schedule_keyed(
        &self,
        routing_key: &str,
        fun: RocksStoreRWLoopFn,
    ) -> Result<(), CubeError> {
        let shard_idx = self.shard_for_key(routing_key);
        self.shards[shard_idx].send(fun).await.map_err(|err| {
            CubeError::user(format!(
                "Failed to schedule keyed task to ShardedRWLoop ({}, shard {}), error: {}",
                self.name, shard_idx, err
            ))
        })
    }

    /// Schedule an operation using round-robin (for operations where ordering doesn't matter).
    pub async fn schedule_any(
        &self,
        hint: u64,
        fun: RocksStoreRWLoopFn,
    ) -> Result<(), CubeError> {
        let shard_idx = (hint as usize) % self.num_shards;
        self.shards[shard_idx].send(fun).await.map_err(|err| {
            CubeError::user(format!(
                "Failed to schedule task to ShardedRWLoop ({}, shard {}), error: {}",
                self.name, shard_idx, err
            ))
        })
    }

    pub fn get_name(&self) -> &'static str {
        self.name
    }

    pub fn num_shards(&self) -> usize {
        self.num_shards
    }

    fn shard_for_key(&self, key: &str) -> usize {
        let mut hasher = DefaultHasher::new();
        key.hash(&mut hasher);
        (hasher.finish() as usize) % self.num_shards
    }
}
