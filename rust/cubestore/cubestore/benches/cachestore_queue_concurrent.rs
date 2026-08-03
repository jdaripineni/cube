//! Concurrent multi-"pod" queue throughput benchmark for the sharded queue RW loop
//! (see `src/cachestore/QUEUE_SHARDING.md`).
//!
//! Unlike `cachestore_queue.rs` (sequential, single-client `queue_add`/`queue_list`/`queue_get`
//! loops), this benchmark simulates N concurrent Cube.js "pods" each looping through the real
//! queue lifecycle -- `queue_add` -> `queue_retrieve_by_path` -> `queue_heartbeat` (x K) ->
//! `queue_ack` -- against a shared queue prefix, and measures aggregate throughput (ops/sec)
//! and per-operation-type p50/p99 latency.
//!
//! This is a plain `harness = false` binary (not a criterion `bench_function`): the workload
//! is a single timed run of a concurrent async workload, not something criterion's
//! statistical-sampling model is a natural fit for. Percentiles are computed by hand from
//! per-call latency samples collected in-process.
//!
//! ## Usage
//!
//! ```sh
//! # "Before": single RW thread (upstream-identical behavior).
//! CUBESTORE_QUEUE_RW_WORKERS=1 cargo bench -p cubestore --bench cachestore_queue_concurrent
//!
//! # "After": sharded across 8 RW worker threads.
//! CUBESTORE_QUEUE_RW_WORKERS=8 cargo bench -p cubestore --bench cachestore_queue_concurrent
//! ```
//!
//! Tunable via env vars (all optional, sane defaults below):
//! - `CUBESTORE_QUEUE_RW_WORKERS` (default `1`, read by `RocksCacheStore` itself)
//! - `BENCH_PODS`                 concurrent simulated pods              (default `100`)
//! - `BENCH_ITERS_PER_POD`        add/retrieve/heartbeat/ack rounds/pod   (default `20`)
//! - `BENCH_HEARTBEATS_PER_ITEM`  heartbeats issued per retrieved item    (default `3`)
//! - `BENCH_ALLOW_CONCURRENCY`    RETRIEVE concurrency limit per prefix   (default = BENCH_PODS)
//! - `BENCH_PREFIXES`             distinct queue prefixes pods spread across (default `1`,
//!   i.e. all pods share one queue; RETRIEVE is serialized per-prefix by design, so `1`
//!   stresses that worst case -- set e.g. equal to BENCH_PODS to model independent
//!   multi-tenant queues instead)
//!
//! See QUEUE_SHARDING.md "## Repeatable Benchmark Process" for the full reproduction recipe
//! and how to read/compare the output against the recorded baseline.

use cubestore::cachestore::{CacheStore, QueueAddPayload, QueueKey, QueueRetrieveResponse, RocksCacheStore};
use cubestore::config::{Config, CubeServices};
use cubestore::CubeError;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::runtime::Builder;

#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash, PartialOrd, Ord)]
enum OpKind {
    Add,
    Retrieve,
    Heartbeat,
    Ack,
}

impl OpKind {
    fn label(&self) -> &'static str {
        match self {
            OpKind::Add => "add",
            OpKind::Retrieve => "retrieve",
            OpKind::Heartbeat => "heartbeat",
            OpKind::Ack => "ack",
        }
    }
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn prepare_cachestore(name: &str) -> Result<Arc<RocksCacheStore>, CubeError> {
    let config = Config::test(name).update_config(|mut config| {
        // Disable periodic background work so it doesn't compete with the benchmark for CPU.
        config.cachestore_cache_eviction_loop_interval = 100_000;
        config
    });

    let (_, cachestore) = RocksCacheStore::prepare_bench_cachestore(name, config);

    let cachestore_to_move = cachestore.clone();
    tokio::task::spawn(async move {
        let loops = cachestore_to_move.spawn_processing_loops();
        CubeServices::wait_loops(loops).await
    });

    Ok(cachestore)
}

/// Percentile over a slice that is already sorted ascending. `p` in [0.0, 100.0].
fn percentile_sorted(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let rank = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

fn fmt_ms(d: Duration) -> String {
    format!("{:.3}", d.as_secs_f64() * 1000.0)
}

async fn run_pod(
    cachestore: Arc<RocksCacheStore>,
    pod_id: usize,
    iters: usize,
    heartbeats_per_item: usize,
    allow_concurrency: u32,
    prefix: String,
) -> Result<Vec<(OpKind, Duration)>, CubeError> {
    let mut samples = Vec::with_capacity(iters * (2 + heartbeats_per_item));

    for i in 0..iters {
        let path = format!("{}:pod-{}-item-{}", prefix, pod_id, i);

        let t0 = Instant::now();
        cachestore
            .queue_add(QueueAddPayload {
                path: path.clone(),
                value: format!("payload-{}-{}", pod_id, i),
                priority: 0,
                orphaned: None,
                process_id: None,
                exclusive: false,
                external_id: None,
            })
            .await?;
        samples.push((OpKind::Add, t0.elapsed()));

        let t0 = Instant::now();
        let retrieve_res = cachestore
            .queue_retrieve_by_path(path.clone(), allow_concurrency, None)
            .await?;
        samples.push((OpKind::Retrieve, t0.elapsed()));

        // Only heartbeat/ack if we actually won the item (mirrors real pod behavior: a pod
        // that didn't get the item wouldn't be heartbeating/acking it).
        if matches!(retrieve_res, QueueRetrieveResponse::Success { .. }) {
            for _ in 0..heartbeats_per_item {
                let t0 = Instant::now();
                cachestore
                    .queue_heartbeat(QueueKey::ByPath(path.clone()))
                    .await?;
                samples.push((OpKind::Heartbeat, t0.elapsed()));
            }

            let t0 = Instant::now();
            cachestore
                .queue_ack(QueueKey::ByPath(path.clone()), Some("done".to_string()))
                .await?;
            samples.push((OpKind::Ack, t0.elapsed()));
        }
    }

    Ok(samples)
}

fn main() {
    let workers = env_usize("CUBESTORE_QUEUE_RW_WORKERS", 1);
    let pods = env_usize("BENCH_PODS", 100);
    let iters_per_pod = env_usize("BENCH_ITERS_PER_POD", 20);
    let heartbeats_per_item = env_usize("BENCH_HEARTBEATS_PER_ITEM", 3);
    let allow_concurrency = env_usize("BENCH_ALLOW_CONCURRENCY", pods) as u32;
    // Number of distinct queue prefixes pods are spread across. `1` (default) matches the
    // doc's "many pods, one shared queue" diagrams and stresses the per-prefix RETRIEVE lock
    // worst-case. Set higher (e.g. equal to BENCH_PODS) to model a multi-tenant workload where
    // each pod/tenant has its own queue -- RETRIEVE then parallelizes across prefixes too.
    let prefixes = env_usize("BENCH_PREFIXES", 1).max(1);

    let available_parallelism = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);

    println!("=== CubeStore queue concurrent benchmark ===");
    println!("host logical cores (available_parallelism): {}", available_parallelism);
    println!("CUBESTORE_QUEUE_RW_WORKERS (shards):         {}", workers);
    println!("BENCH_PODS (concurrent tasks):                {}", pods);
    println!("BENCH_ITERS_PER_POD:                          {}", iters_per_pod);
    println!("BENCH_HEARTBEATS_PER_ITEM:                    {}", heartbeats_per_item);
    println!("BENCH_ALLOW_CONCURRENCY (per-prefix limit):   {}", allow_concurrency);
    println!("BENCH_PREFIXES (distinct queues):             {}", prefixes);

    let runtime = Builder::new_multi_thread().enable_all().build().unwrap();

    let store_name = format!("cachestore_queue_concurrent_bench_w{}", workers);
    let cachestore = runtime
        .block_on(async { prepare_cachestore(&store_name) })
        .expect("failed to prepare cachestore");

    let start = Instant::now();
    let all_samples: Vec<(OpKind, Duration)> = runtime.block_on(async move {
        let mut handles = Vec::with_capacity(pods);
        for pod_id in 0..pods {
            let cachestore = cachestore.clone();
            let prefix = format!("BENCH#queue-{}", pod_id % prefixes);
            handles.push(tokio::task::spawn(async move {
                run_pod(
                    cachestore,
                    pod_id,
                    iters_per_pod,
                    heartbeats_per_item,
                    allow_concurrency,
                    prefix,
                )
                .await
            }));
        }

        let mut all = Vec::new();
        for h in handles {
            let samples = h
                .await
                .expect("pod task panicked")
                .expect("pod task returned an error");
            all.extend(samples);
        }
        all
    });
    let elapsed = start.elapsed();

    let total_ops = all_samples.len();
    let ops_per_sec = total_ops as f64 / elapsed.as_secs_f64();

    let mut by_kind: HashMap<OpKind, Vec<Duration>> = HashMap::new();
    for (kind, dur) in &all_samples {
        by_kind.entry(*kind).or_default().push(*dur);
    }

    println!();
    println!("--- Results ---");
    println!("wall-clock time:      {:.3} s", elapsed.as_secs_f64());
    println!("total ops:            {}", total_ops);
    println!("aggregate throughput: {:.1} ops/sec", ops_per_sec);
    println!();
    println!(
        "{:<10} {:>10} {:>12} {:>12} {:>12} {:>12}",
        "op", "count", "p50 (ms)", "p90 (ms)", "p99 (ms)", "max (ms)"
    );
    let mut kinds: Vec<OpKind> = by_kind.keys().copied().collect();
    kinds.sort();
    for kind in kinds {
        let mut durs = by_kind.remove(&kind).unwrap();
        durs.sort();
        let p50 = percentile_sorted(&durs, 50.0);
        let p90 = percentile_sorted(&durs, 90.0);
        let p99 = percentile_sorted(&durs, 99.0);
        let max = *durs.last().unwrap();
        println!(
            "{:<10} {:>10} {:>12} {:>12} {:>12} {:>12}",
            kind.label(),
            durs.len(),
            fmt_ms(p50),
            fmt_ms(p90),
            fmt_ms(p99),
            fmt_ms(max)
        );
    }

    // Also report overall (all op kinds combined) p50/p99, useful as a single headline number.
    let mut all_durs: Vec<Duration> = all_samples.into_iter().map(|(_, d)| d).collect();
    all_durs.sort();
    println!();
    println!(
        "overall: p50={} ms, p90={} ms, p99={} ms, max={} ms",
        fmt_ms(percentile_sorted(&all_durs, 50.0)),
        fmt_ms(percentile_sorted(&all_durs, 90.0)),
        fmt_ms(percentile_sorted(&all_durs, 99.0)),
        fmt_ms(*all_durs.last().unwrap())
    );

    // Note: `prepare_bench_cachestore` writes under `db-tmp/benchmarks/<name>` (gitignored),
    // matching the existing `cachestore_queue` bench's convention of not cleaning up after
    // itself -- left in place so a failed/interrupted run's DB can be inspected.
}
