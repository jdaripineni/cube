//! Isolates a specific question about the sharded queue RW loop (see
//! `src/cachestore/QUEUE_SHARDING.md`): does heavy background heartbeat/ack traffic from
//! OTHER already-executing queries slow down a NEW query's `queue_add` -> `queue_retrieve_by_path`
//! ("pickup") call, and does `CUBESTORE_QUEUE_RW_WORKERS` sharding fix that specific interaction?
//!
//! This is deliberately different from `cachestore_queue_concurrent.rs`'s Scenario A/B: those
//! benchmarks have every simulated pod doing add+retrieve+heartbeat+ack in lockstep, which
//! conflates "many pods simultaneously retrieving" (RETRIEVE-vs-RETRIEVE contention, serialized
//! by the per-prefix `retrieve_lock` regardless of shard count -- see QUEUE_SHARDING.md) with
//! "one pod trying to retrieve while many OTHER pods are just heartbeating/acking in the
//! background" (a completely different interaction: heartbeat/ack route via `schedule_keyed`
//! to sharded OS threads, so sharding *can* reduce their queueing footprint on whichever shard
//! a foreground retrieve's write happens to hash to).
//!
//! ## Design
//!
//! 1. **Background load**: pre-populate `BG_ITEMS` items under one shared queue prefix (each
//!    `queue_add`ed then immediately `queue_retrieve_by_path`ed by this setup phase itself, using
//!    a very high `allow_concurrency` so every one succeeds and becomes `Active`). Then spawn
//!    `BG_ITEMS` long-running tokio tasks, each looping `queue_heartbeat` on its own item with a
//!    target minimum gap of `BG_HEARTBEAT_INTERVAL_MS` between calls (a real pod issuing
//!    "still working" heartbeats while it executes a query). These tasks run for the entire
//!    duration of the foreground measurement phase below, then stop.
//!
//! 2. **Foreground measurement**: `FG_SUBMITTERS` tasks (default `1`, so this benchmark is NOT
//!    also measuring retrieve-vs-retrieve contention -- that is already covered by
//!    `cachestore_queue_concurrent.rs` Scenario A) each sequentially repeat, `FG_ITERS` times:
//!    `queue_add` a uniquely-pathed new item under the SAME shared prefix as the background
//!    items, then `queue_retrieve_by_path` that exact path (also with a very high
//!    `allow_concurrency`, so it is never denied by the concurrency counter -- only latency is
//!    measured, not admission blocking). The combined add+retrieve wall-clock time is recorded
//!    as "pickup latency" -- literally "time from submission to being picked up for execution".
//!    Add-only and retrieve-only sub-latencies are also recorded separately. Each foreground
//!    item is `queue_ack`ed immediately after being measured (untimed) so it does not
//!    permanently inflate the shared prefix's active-item count across iterations -- only the
//!    `BG_ITEMS` background items stay `Active` for the whole run, keeping `BG_ITEMS` the one
//!    independent variable under test.
//!
//! ## Usage
//!
//! ```sh
//! # "Before": single RW thread.
//! CUBESTORE_QUEUE_RW_WORKERS=1 BG_ITEMS=2000 cargo bench -p cubestore --bench cachestore_queue_pickup_latency
//!
//! # "After": sharded across 8 RW worker threads.
//! CUBESTORE_QUEUE_RW_WORKERS=8 BG_ITEMS=2000 cargo bench -p cubestore --bench cachestore_queue_pickup_latency
//! ```
//!
//! Tunable via env vars (all optional, sane defaults below):
//! - `CUBESTORE_QUEUE_RW_WORKERS`   (default `1`, read by `RocksCacheStore` itself)
//! - `BG_ITEMS`                     background "already executing" items sharing one prefix (default `1000`)
//! - `BG_HEARTBEAT_INTERVAL_MS`     minimum gap between a background item's heartbeat calls (default `10`)
//! - `FG_SUBMITTERS`                concurrent foreground submitter tasks (default `1`)
//! - `FG_ITERS`                     add+retrieve rounds per foreground submitter (default `300`)
//! - `FG_WARMUP_MS`                 delay after starting background load, before starting the
//!   timed foreground phase, to let background contention reach steady state (default `300`)
//! - `PICKUP_ALLOW_CONCURRENCY`     `allow_concurrency` passed to every RETRIEVE in this
//!   benchmark (background population and foreground measurement alike) -- deliberately huge
//!   so nothing is ever denied by the concurrency counter; only latency is measured
//!   (default `10000000`)
//!
//! See QUEUE_SHARDING.md "## Does Stage 1 Reduce Query Pickup (Queue-Wait) Latency?" for the
//! full write-up of what this benchmark found, and the exact commands used.

use cubestore::cachestore::{CacheStore, QueueAddPayload, QueueKey, QueueRetrieveResponse, RocksCacheStore};
use cubestore::config::{Config, CubeServices};
use cubestore::CubeError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::runtime::Builder;

const SHARED_PREFIX: &str = "PICKUP#shared";

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

fn print_stats(label: &str, mut durs: Vec<Duration>) {
    if durs.is_empty() {
        println!("{:<24} (no samples)", label);
        return;
    }
    durs.sort();
    let p50 = percentile_sorted(&durs, 50.0);
    let p90 = percentile_sorted(&durs, 90.0);
    let p99 = percentile_sorted(&durs, 99.0);
    let max = *durs.last().unwrap();
    println!(
        "{:<24} {:>10} {:>12} {:>12} {:>12} {:>12}",
        label,
        durs.len(),
        fmt_ms(p50),
        fmt_ms(p90),
        fmt_ms(p99),
        fmt_ms(max)
    );
}

async fn populate_background_items(
    cachestore: &Arc<RocksCacheStore>,
    bg_items: usize,
    allow_concurrency: u32,
) -> Result<Vec<String>, CubeError> {
    let mut paths = Vec::with_capacity(bg_items);
    for i in 0..bg_items {
        let path = format!("{}:bg-item-{}", SHARED_PREFIX, i);
        cachestore
            .queue_add(QueueAddPayload {
                path: path.clone(),
                value: format!("bg-payload-{}", i),
                priority: 0,
                orphaned: None,
                process_id: None,
                exclusive: false,
                external_id: None,
            })
            .await?;

        let res = cachestore
            .queue_retrieve_by_path(path.clone(), allow_concurrency, None)
            .await?;
        if !matches!(res, QueueRetrieveResponse::Success { .. }) {
            eprintln!(
                "WARNING: background item {} did not retrieve as Success: {:?}",
                path,
                std::mem::discriminant(&res)
            );
        }
        paths.push(path);
    }
    Ok(paths)
}

async fn background_heartbeat_loop(
    cachestore: Arc<RocksCacheStore>,
    path: String,
    interval: Duration,
    stop: Arc<AtomicBool>,
    stagger: Duration,
) -> Vec<Duration> {
    let mut samples = Vec::new();
    tokio::time::sleep(stagger).await;
    while !stop.load(Ordering::Relaxed) {
        let t0 = Instant::now();
        let res = cachestore.queue_heartbeat(QueueKey::ByPath(path.clone())).await;
        if res.is_ok() {
            samples.push(t0.elapsed());
        }
        tokio::time::sleep(interval).await;
    }
    samples
}

async fn run_foreground_submitter(
    cachestore: Arc<RocksCacheStore>,
    submitter_id: usize,
    iters: usize,
    allow_concurrency: u32,
) -> Result<Vec<(Duration, Duration, Duration)>, CubeError> {
    // (pickup = add+retrieve, add-only, retrieve-only)
    let mut samples = Vec::with_capacity(iters);

    for i in 0..iters {
        let path = format!("{}:fg-{}-{}", SHARED_PREFIX, submitter_id, i);

        let t0 = Instant::now();
        cachestore
            .queue_add(QueueAddPayload {
                path: path.clone(),
                value: format!("fg-payload-{}-{}", submitter_id, i),
                priority: 0,
                orphaned: None,
                process_id: None,
                exclusive: false,
                external_id: None,
            })
            .await?;
        let t_add = t0.elapsed();

        let t1 = Instant::now();
        let res = cachestore
            .queue_retrieve_by_path(path.clone(), allow_concurrency, None)
            .await?;
        let t_retrieve = t1.elapsed();
        let pickup = t0.elapsed();

        if !matches!(res, QueueRetrieveResponse::Success { .. }) {
            eprintln!(
                "WARNING: foreground item {} did not retrieve as Success -- pickup latency sample is suspect",
                path
            );
        }

        samples.push((pickup, t_add, t_retrieve));

        // Untimed cleanup: ack immediately so this item doesn't linger Active and inflate the
        // shared prefix's active-item count for subsequent iterations/other submitters. Only
        // BG_ITEMS should determine that count for the duration of the measurement.
        let _ = cachestore
            .queue_ack(QueueKey::ByPath(path.clone()), Some("done".to_string()))
            .await;
    }

    Ok(samples)
}

fn main() {
    let workers = env_usize("CUBESTORE_QUEUE_RW_WORKERS", 1);
    let bg_items = env_usize("BG_ITEMS", 1000);
    let bg_heartbeat_interval_ms = env_usize("BG_HEARTBEAT_INTERVAL_MS", 10) as u64;
    let fg_submitters = env_usize("FG_SUBMITTERS", 1);
    let fg_iters = env_usize("FG_ITERS", 300);
    let fg_warmup_ms = env_usize("FG_WARMUP_MS", 300) as u64;
    let allow_concurrency = env_usize("PICKUP_ALLOW_CONCURRENCY", 10_000_000) as u32;

    let available_parallelism = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);

    println!("=== CubeStore queue pickup-latency benchmark ===");
    println!("host logical cores (available_parallelism): {}", available_parallelism);
    println!("CUBESTORE_QUEUE_RW_WORKERS (shards):         {}", workers);
    println!("BG_ITEMS (background active items):          {}", bg_items);
    println!("BG_HEARTBEAT_INTERVAL_MS:                     {}", bg_heartbeat_interval_ms);
    println!("FG_SUBMITTERS:                                {}", fg_submitters);
    println!("FG_ITERS (per submitter):                     {}", fg_iters);
    println!("FG_WARMUP_MS:                                 {}", fg_warmup_ms);
    println!("PICKUP_ALLOW_CONCURRENCY:                     {}", allow_concurrency);

    let runtime = Builder::new_multi_thread().enable_all().build().unwrap();

    let store_name = format!("cachestore_queue_pickup_latency_bench_w{}", workers);
    let cachestore = runtime
        .block_on(async { prepare_cachestore(&store_name) })
        .expect("failed to prepare cachestore");

    // --- Phase 1: populate background items (untimed setup) ---
    let setup_start = Instant::now();
    let bg_paths = runtime
        .block_on(populate_background_items(&cachestore, bg_items, allow_concurrency))
        .expect("failed to populate background items");
    println!(
        "background population done: {} items in {:.3} s",
        bg_paths.len(),
        setup_start.elapsed().as_secs_f64()
    );

    // --- Phase 2: spawn background heartbeat loops + run timed foreground measurement ---
    let stop = Arc::new(AtomicBool::new(false));
    let interval = Duration::from_millis(bg_heartbeat_interval_ms.max(1));

    let (fg_samples, bg_samples, fg_wall): (
        Vec<(Duration, Duration, Duration)>,
        Vec<Duration>,
        Duration,
    ) = runtime.block_on(async move {
        let mut bg_handles = Vec::with_capacity(bg_items);
        for (i, path) in bg_paths.into_iter().enumerate() {
            let cachestore = cachestore.clone();
            let stop = stop.clone();
            // Stagger initial phase so BG_ITEMS tasks don't all fire heartbeats in lockstep.
            let stagger = Duration::from_millis((i as u64) % interval.as_millis().max(1) as u64);
            bg_handles.push(tokio::task::spawn(background_heartbeat_loop(
                cachestore, path, interval, stop, stagger,
            )));
        }

        if fg_warmup_ms > 0 {
            tokio::time::sleep(Duration::from_millis(fg_warmup_ms)).await;
        }

        let fg_start = Instant::now();
        let mut fg_handles = Vec::with_capacity(fg_submitters);
        for submitter_id in 0..fg_submitters {
            let cachestore = cachestore.clone();
            fg_handles.push(tokio::task::spawn(run_foreground_submitter(
                cachestore,
                submitter_id,
                fg_iters,
                allow_concurrency,
            )));
        }

        let mut fg_samples = Vec::new();
        for h in fg_handles {
            let samples = h
                .await
                .expect("foreground submitter task panicked")
                .expect("foreground submitter task returned an error");
            fg_samples.extend(samples);
        }
        let fg_wall = fg_start.elapsed();

        // Foreground measurement is done -- stop background load and collect its samples.
        stop.store(true, Ordering::Relaxed);
        let mut bg_samples = Vec::new();
        for h in bg_handles {
            let samples = h.await.expect("background heartbeat task panicked");
            bg_samples.extend(samples);
        }

        (fg_samples, bg_samples, fg_wall)
    });

    println!();
    println!("--- Results ---");
    println!(
        "foreground measurement wall-clock: {:.3} s ({} submitter(s) x {} iters = {} pickups)",
        fg_wall.as_secs_f64(),
        fg_submitters,
        fg_iters,
        fg_samples.len()
    );
    println!(
        "background heartbeat samples collected: {} (across {} background items)",
        bg_samples.len(),
        bg_items
    );
    println!();
    println!(
        "{:<24} {:>10} {:>12} {:>12} {:>12} {:>12}",
        "metric", "count", "p50 (ms)", "p90 (ms)", "p99 (ms)", "max (ms)"
    );

    let pickup: Vec<Duration> = fg_samples.iter().map(|(p, _, _)| *p).collect();
    let add_only: Vec<Duration> = fg_samples.iter().map(|(_, a, _)| *a).collect();
    let retrieve_only: Vec<Duration> = fg_samples.iter().map(|(_, _, r)| *r).collect();

    print_stats("fg_pickup(add+retrieve)", pickup);
    print_stats("fg_add_only", add_only);
    print_stats("fg_retrieve_only", retrieve_only);
    print_stats("bg_heartbeat", bg_samples);

    // Note: `prepare_bench_cachestore` writes under `db-tmp/benchmarks/<name>` (gitignored),
    // matching the existing benches' convention of not cleaning up after itself -- left in
    // place so a failed/interrupted run's DB can be inspected.
}
