//! Reproduces (as closely as a single local process can) the reported production symptom:
//! ~40 Cube.js pods behind ONE shared CubeStore queue prefix (per
//! `packages/cubejs-query-orchestrator/src/orchestrator/QueryCache.ts` /
//! `PreAggregations.ts` -- the prefix is `(orchestratorId, dataSource)` only, never cube
//! identity, so a typical single-tenant/single-datasource deployment funnels through one
//! shared prefix regardless of cube count), with a REALISTIC finite `allow_concurrency`
//! admission limit and REALISTIC query hold/execution time -- causing intermittent queue-wait
//! (pickup latency) *spikes* rather than a constantly-elevated baseline.
//!
//! See `src/cachestore/QUEUE_SHARDING.md` -> "## Production Incident Repro: ~40 Pods, Shared
//! Prefix, Realistic Concurrency Limits" for the full write-up, hypothesis, and results table.
//!
//! ## Why this benchmark exists (gap in the other two)
//!
//! - `cachestore_queue_concurrent.rs` (Scenario A/Experiment 2) and
//!   `cachestore_queue_pickup_latency.rs` (Experiment 1) both ack an item essentially
//!   immediately after a successful retrieve -- near-zero hold time. That means the `Active`
//!   list for a prefix never sustains meaningful size, and neither benchmark uses a finite,
//!   realistic `allow_concurrency` (both pass a value large enough that admission blocking
//!   (`QueueRetrieveResponse::NotEnoughConcurrency`) essentially never triggers).
//! - Real Cube.js queries hold their queue slot for the duration of the actual warehouse query
//!   (sub-second to ~2s), and query concurrency is admission-controlled by a real, finite
//!   `allow_concurrency` (reported as "somewhere in the 10-50+ range" in production). This
//!   benchmark models both, plus the closed-loop demand pattern of a fixed pod population each
//!   continuously submitting new queries.
//!
//! ## Design
//!
//! 1. **One shared prefix** (`PROD#shared`) for all traffic -- matches Scenario A / Experiment
//!    2, not the multi-prefix Scenario B, per the established fact that cube identity never
//!    enters the CubeStore queue key.
//! 2. **`PODS` concurrent "pod" tasks**, each looping continuously for the run duration:
//!    `queue_add` a uniquely-pathed new item -> retry `queue_retrieve_by_path` (with a finite
//!    `ALLOW_CONCURRENCY`) until `Success`, polling every `POLL_INTERVAL_MS` on any non-Success
//!    response -> hold the item `Active` for `HOLD_MS` (`tokio::time::sleep`, standing in for
//!    real warehouse query execution time) -> `queue_ack`.
//! 3. **Pickup latency** = wall-clock time from the start of `queue_add` to the moment
//!    `queue_retrieve_by_path` returns `Success` for that same path (including all failed-retry
//!    polling in between) -- this is "time from submission to being picked up for execution",
//!    the thing the reported 3-30s symptom is actually about.
//! 4. **Warmup**: samples are only recorded for cycles that *start* after `WARMUP_MS` has
//!    elapsed, so the reported percentiles reflect steady-state load, not cold-start effects
//!    (empty prefix, no contention yet).
//! 3. **Background monitor task**: every `ACTIVE_SAMPLE_INTERVAL_MS`, records the prefix's
//!    current Active-item count and Pending-item count via `queue_list` (a direct snapshot
//!    read, bypassing the RW loop/retrieve_lock -- doesn't perturb the thing being measured).
//!    This directly tests the feedback-loop hypothesis: does Pending backlog (and/or Active
//!    count) grow over the run, and does pickup latency track that growth non-linearly?
//! 5. **Hard safety timeout**: pickup samples are pushed into a shared `Mutex<Vec<_>>` as each
//!    cycle completes (not returned only at task-join time), so if the run is in a genuine
//!    cascade and some pods are still stuck mid-retry-loop when `HARD_TIMEOUT_GRACE_MS` past the
//!    nominal run end elapses, whatever samples *did* complete are still reported (with a loud
//!    warning) instead of the whole run hanging indefinitely on stragglers. The process then
//!    force-exits (`std::process::exit`) rather than waiting for the tokio runtime to drain
//!    abandoned tasks.
//!
//! ## Usage
//!
//! ```sh
//! CUBESTORE_QUEUE_RW_WORKERS=1 PODS=40 HOLD_MS=500 ALLOW_CONCURRENCY=20 \
//!   cargo bench -p cubestore --bench cachestore_queue_production_repro
//! ```
//!
//! Tunable via env vars (all optional, sane defaults below):
//! - `CUBESTORE_QUEUE_RW_WORKERS`   (default `1`, read by `RocksCacheStore` itself)
//! - `PODS`                         concurrent submitting "pod" tasks (default `40`)
//! - `HOLD_MS`                      simulated query execution/hold time per item (default `500`)
//! - `ALLOW_CONCURRENCY`            finite per-prefix admission limit passed to every
//!   `queue_retrieve_by_path` call (default `20`) -- NOT an artificially huge value; this is
//!   the real admission-control mechanism production relies on.
//! - `POLL_INTERVAL_MS`             backoff/retry interval after a non-Success retrieve
//!   response (default `100`; the real Cube.js client uses a longer blocking-wait + reconcile
//!   pattern with a default 5s `continueWaitTimeout` -- a shorter interval here is fine and
//!   arguably more conservative/revealing for finding the contention mechanism itself)
//! - `WARMUP_MS`                    delay before recording samples, to reach steady state
//!   (default `500`)
//! - `RUN_MS`                       steady-state measurement window duration (default `5000`)
//! - `ACTIVE_SAMPLE_INTERVAL_MS`    monitor task sampling period for active/pending counts
//!   (default `250`)
//! - `HARD_TIMEOUT_GRACE_MS`        extra grace period after `WARMUP_MS + RUN_MS` before the
//!   benchmark force-stops and reports partial results rather than hanging on stragglers
//!   (default `15000`)
//!
//! See QUEUE_SHARDING.md for the full sweep and results.

use cubestore::cachestore::{
    CacheStore, QueueAddPayload, QueueItemStatus, QueueKey, QueueRetrieveResponse, RocksCacheStore,
};
use cubestore::config::{Config, CubeServices};
use cubestore::CubeError;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::runtime::Builder;

const SHARED_PREFIX: &str = "PROD#shared";

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
    hold_ms: u64,
    allow_concurrency: u32,
    poll_interval: Duration,
    warmup_deadline: Instant,
    run_deadline: Instant,
    results: Arc<Mutex<Vec<Duration>>>,
    retrieve_attempts: Arc<AtomicU64>,
    retrieve_rejections: Arc<AtomicU64>,
    cycles_completed: Arc<AtomicU64>,
) {
    let mut iter: u64 = 0;

    loop {
        if Instant::now() >= run_deadline {
            break;
        }
        let should_record = Instant::now() >= warmup_deadline;

        let path = format!("{}:pod-{}-item-{}", SHARED_PREFIX, pod_id, iter);
        iter += 1;

        let t0 = Instant::now();
        if let Err(e) = cachestore
            .queue_add(QueueAddPayload {
                path: path.clone(),
                value: format!("payload-{}-{}", pod_id, iter),
                priority: 0,
                orphaned: None,
                process_id: None,
                exclusive: false,
                external_id: None,
            })
            .await
        {
            eprintln!("WARNING: queue_add failed for {}: {:?}", path, e);
            tokio::time::sleep(Duration::from_millis(20)).await;
            continue;
        }

        // Retry-until-successful retrieve, modeling the real client's "submit, then poll until
        // admitted" behavior (production uses a longer blocking-wait + reconcile with a 5s
        // default `continueWaitTimeout`; a shorter poll here is intentionally more aggressive --
        // see file header doc comment for why that's fine/conservative for this experiment).
        // This loop only ever exits via the `Success` break below -- it retries indefinitely
        // otherwise, matching a real pod that keeps polling until admitted.
        loop {
            retrieve_attempts.fetch_add(1, Ordering::Relaxed);
            match cachestore
                .queue_retrieve_by_path(path.clone(), allow_concurrency, None)
                .await
            {
                Ok(QueueRetrieveResponse::Success { .. }) => break,
                Ok(_) => {
                    retrieve_rejections.fetch_add(1, Ordering::Relaxed);
                    tokio::time::sleep(poll_interval).await;
                }
                Err(e) => {
                    eprintln!("WARNING: queue_retrieve_by_path errored for {}: {:?}", path, e);
                    tokio::time::sleep(poll_interval).await;
                }
            }
        }

        let pickup = t0.elapsed();
        if should_record {
            results.lock().unwrap().push(pickup);
        }

        // Hold the item Active for HOLD_MS, standing in for real warehouse query execution
        // time -- this is the realism gap the existing two benchmarks don't model.
        if hold_ms > 0 {
            tokio::time::sleep(Duration::from_millis(hold_ms)).await;
        }

        let _ = cachestore
            .queue_ack(QueueKey::ByPath(path.clone()), Some("done".to_string()))
            .await;

        if should_record {
            cycles_completed.fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn monitor_active_pending(
    cachestore: Arc<RocksCacheStore>,
    interval: Duration,
    start: Instant,
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<(Duration, usize, usize)>>>,
) {
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let active = cachestore
            .queue_list(
                SHARED_PREFIX.to_string(),
                Some(QueueItemStatus::Active),
                false,
                false,
                None,
            )
            .await
            .map(|v| v.len())
            .unwrap_or(0);
        let pending = cachestore
            .queue_list(
                SHARED_PREFIX.to_string(),
                Some(QueueItemStatus::Pending),
                false,
                false,
                None,
            )
            .await
            .map(|v| v.len())
            .unwrap_or(0);
        let t = start.elapsed();
        println!("MONITOR t={:.3}s active={} pending={}", t.as_secs_f64(), active, pending);
        samples.lock().unwrap().push((t, active, pending));
        tokio::time::sleep(interval).await;
    }
}

fn main() {
    let workers = env_usize("CUBESTORE_QUEUE_RW_WORKERS", 1);
    let pods = env_usize("PODS", 40);
    let hold_ms = env_usize("HOLD_MS", 500) as u64;
    let allow_concurrency = env_usize("ALLOW_CONCURRENCY", 20) as u32;
    let poll_interval_ms = env_usize("POLL_INTERVAL_MS", 100) as u64;
    let warmup_ms = env_usize("WARMUP_MS", 500) as u64;
    let run_ms = env_usize("RUN_MS", 5000) as u64;
    let active_sample_interval_ms = env_usize("ACTIVE_SAMPLE_INTERVAL_MS", 250) as u64;
    let hard_timeout_grace_ms = env_usize("HARD_TIMEOUT_GRACE_MS", 15000) as u64;

    let theoretical_max_throughput = allow_concurrency as f64 / (hold_ms.max(1) as f64 / 1000.0);

    let available_parallelism = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);

    println!("=== CubeStore queue PRODUCTION REPRO benchmark ===");
    println!("host logical cores (available_parallelism): {}", available_parallelism);
    println!("CUBESTORE_QUEUE_RW_WORKERS (shards):         {}", workers);
    println!("PODS (concurrent submitting tasks):          {}", pods);
    println!("HOLD_MS (simulated query exec time):         {}", hold_ms);
    println!("ALLOW_CONCURRENCY (per-prefix admission):    {}", allow_concurrency);
    println!("POLL_INTERVAL_MS (retry backoff):            {}", poll_interval_ms);
    println!("WARMUP_MS:                                    {}", warmup_ms);
    println!("RUN_MS (steady-state window):                {}", run_ms);
    println!("ACTIVE_SAMPLE_INTERVAL_MS:                    {}", active_sample_interval_ms);
    println!("HARD_TIMEOUT_GRACE_MS:                        {}", hard_timeout_grace_ms);
    println!(
        "theoretical max throughput C/(H/1000):        {:.2} items/sec",
        theoretical_max_throughput
    );
    println!(
        "demand/capacity ratio (PODS vs ALLOW_CONCURRENCY): {:.2}x",
        pods as f64 / allow_concurrency as f64
    );

    let runtime = Builder::new_multi_thread().enable_all().build().unwrap();

    let store_name = format!("cachestore_queue_production_repro_bench_w{}", workers);
    let cachestore = runtime
        .block_on(async { prepare_cachestore(&store_name) })
        .expect("failed to prepare cachestore");

    let poll_interval = Duration::from_millis(poll_interval_ms.max(1));
    let results: Arc<Mutex<Vec<Duration>>> = Arc::new(Mutex::new(Vec::new()));
    let monitor_samples: Arc<Mutex<Vec<(Duration, usize, usize)>>> = Arc::new(Mutex::new(Vec::new()));
    let retrieve_attempts = Arc::new(AtomicU64::new(0));
    let retrieve_rejections = Arc::new(AtomicU64::new(0));
    let cycles_completed = Arc::new(AtomicU64::new(0));
    let monitor_stop = Arc::new(AtomicBool::new(false));

    let overall_start = Instant::now();
    let warmup_deadline = overall_start + Duration::from_millis(warmup_ms);
    let run_deadline = warmup_deadline + Duration::from_millis(run_ms);
    let hard_deadline_from_now =
        Duration::from_millis(warmup_ms + run_ms + hard_timeout_grace_ms);

    let hit_hard_timeout = runtime.block_on(async {
        let monitor_handle = tokio::task::spawn(monitor_active_pending(
            cachestore.clone(),
            Duration::from_millis(active_sample_interval_ms.max(1)),
            overall_start,
            monitor_stop.clone(),
            monitor_samples.clone(),
        ));

        let mut pod_handles = Vec::with_capacity(pods);
        for pod_id in 0..pods {
            pod_handles.push(tokio::task::spawn(run_pod(
                cachestore.clone(),
                pod_id,
                hold_ms,
                allow_concurrency,
                poll_interval,
                warmup_deadline,
                run_deadline,
                results.clone(),
                retrieve_attempts.clone(),
                retrieve_rejections.clone(),
                cycles_completed.clone(),
            )));
        }

        let join_all = futures::future::join_all(pod_handles);
        let hit_timeout = tokio::time::timeout(hard_deadline_from_now, join_all)
            .await
            .is_err();

        monitor_stop.store(true, Ordering::Relaxed);
        // Give the monitor task a brief moment to notice `stop` and exit; don't block forever.
        let _ = tokio::time::timeout(Duration::from_millis(500), monitor_handle).await;

        hit_timeout
    });

    if hit_hard_timeout {
        eprintln!(
            "WARNING: HARD_TIMEOUT_GRACE_MS exceeded -- one or more pod tasks were still stuck \
             mid-retry when the benchmark force-stopped. Results below reflect only cycles that \
             completed before the timeout; this itself is evidence of a severe cascade at this \
             parameter combination."
        );
    }

    let elapsed_total = overall_start.elapsed();
    let mut pickup_samples = results.lock().unwrap().clone();
    pickup_samples.sort();

    let n = pickup_samples.len();
    let p50 = percentile_sorted(&pickup_samples, 50.0);
    let p90 = percentile_sorted(&pickup_samples, 90.0);
    let p99 = percentile_sorted(&pickup_samples, 99.0);
    let max = pickup_samples.last().copied().unwrap_or(Duration::ZERO);
    let throughput = if run_ms > 0 {
        n as f64 / (run_ms as f64 / 1000.0)
    } else {
        0.0
    };

    let attempts = retrieve_attempts.load(Ordering::Relaxed);
    let rejections = retrieve_rejections.load(Ordering::Relaxed);
    let completed = cycles_completed.load(Ordering::Relaxed);

    let mon = monitor_samples.lock().unwrap();
    let active_max = mon.iter().map(|(_, a, _)| *a).max().unwrap_or(0);
    let pending_max = mon.iter().map(|(_, _, p)| *p).max().unwrap_or(0);
    let pending_end = mon.last().map(|(_, _, p)| *p).unwrap_or(0);
    drop(mon);

    println!();
    println!("--- Results ---");
    println!("total wall-clock (incl. warmup + any hard-timeout grace): {:.3} s", elapsed_total.as_secs_f64());
    println!("hard timeout hit: {}", hit_hard_timeout);
    println!("steady-state pickup samples (n):                          {}", n);
    println!("steady-state completed cycles (add->retrieve->hold->ack): {}", completed);
    println!("retrieve attempts (incl. retries):                        {}", attempts);
    println!("retrieve rejections (NotEnoughConcurrency/other):          {}", rejections);
    println!("observed steady-state throughput:                         {:.2} items/sec", throughput);
    println!("observed active-item high-water mark:                     {}", active_max);
    println!("observed pending-item high-water mark:                    {}", pending_max);
    println!("pending backlog at end of run:                            {}", pending_end);
    println!();
    println!(
        "{:<10} {:>10} {:>12} {:>12} {:>12} {:>12}",
        "metric", "n", "p50 (ms)", "p90 (ms)", "p99 (ms)", "max (ms)"
    );
    println!(
        "{:<10} {:>10} {:>12} {:>12} {:>12} {:>12}",
        "pickup",
        n,
        fmt_ms(p50),
        fmt_ms(p90),
        fmt_ms(p99),
        fmt_ms(max)
    );

    // Single-line CSV-style summary for easy cross-run grepping/tabulation.
    println!();
    println!(
        "SUMMARY,workers={},pods={},hold_ms={},concurrency={},poll_ms={},demand_ratio={:.2},throughput={:.2},p50_ms={:.3},p90_ms={:.3},p99_ms={:.3},max_ms={:.3},n={},active_max={},pending_max={},pending_end={},hard_timeout={}",
        workers,
        pods,
        hold_ms,
        allow_concurrency,
        poll_interval_ms,
        pods as f64 / allow_concurrency as f64,
        throughput,
        p50.as_secs_f64() * 1000.0,
        p90.as_secs_f64() * 1000.0,
        p99.as_secs_f64() * 1000.0,
        max.as_secs_f64() * 1000.0,
        n,
        active_max,
        pending_max,
        pending_end,
        hit_hard_timeout,
    );

    // Note: `prepare_bench_cachestore` writes under `db-tmp/benchmarks/<name>` (gitignored),
    // matching the existing benches' convention of not cleaning up after itself -- left in
    // place so a failed/interrupted run's DB can be inspected.

    // Force-exit rather than letting the tokio Runtime drain/await any abandoned pod tasks
    // (relevant when `hit_hard_timeout` is true) -- this is a one-shot measurement binary, not
    // a long-lived server, so there is nothing worth waiting for after results are printed.
    std::io::stdout().flush().ok();
    std::process::exit(0);
}
