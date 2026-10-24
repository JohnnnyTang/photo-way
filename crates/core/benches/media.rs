//! Throughput benchmark for the media pipeline (`cargo bench -p photoway-core --bench media`).
//!
//! Environment:
//! - `PW_BENCH_FILE`: image to replicate (default: the committed HEIC fixture; point it at a
//!   real 12 MP iPhone HEIC for meaningful numbers).
//! - `PW_BENCH_N`: number of files (default 64).
//! - `PW_BENCH_FULL`: `web` (default), `none` or `original`.
//!
//! For each (workers x libheif threads) combination it runs the full pipeline without a
//! cache and prints files/s plus the extrapolated time for 1,000 files, then a second run
//! with a warm cache.

use std::path::PathBuf;
use std::time::Instant;

use photoway_core::NoProgress;
use photoway_core::media::{Decoder, FullSize, MediaOptions, default_decoders, process_with};
use photoway_core::meta::Meta;
use photoway_core::model::Kind;
use photoway_core::scan::{Entry, ScanReport};

fn main() {
    let src: PathBuf = std::env::var_os("PW_BENCH_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/sample-o6.heic"));
    let n: usize = std::env::var("PW_BENCH_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64);
    let full = match std::env::var("PW_BENCH_FULL").as_deref() {
        Ok("none") => FullSize::None,
        Ok("original") => FullSize::Original,
        _ => FullSize::Web,
    };

    let dir = tempfile::tempdir().expect("tempdir");
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("heic")
        .to_owned();
    let entries: Vec<Entry> = (0..n)
        .map(|i| {
            let p = dir.path().join(format!("img{i:05}.{ext}"));
            std::fs::copy(&src, &p).expect("copy");
            Entry {
                path: p,
                motion: None,
                meta: Meta {
                    kind: Kind::Photo,
                    lat: 0.0,
                    lon: 0.0,
                    alt: None,
                    time: None,
                    ts: None,
                    ts_source: None,
                    day: None,
                    w: 0,
                    h: 0,
                    orientation: 1,
                    dur: None,
                },
            }
        })
        .collect();
    let report = ScanReport {
        entries,
        skipped: vec![],
    };
    let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
    println!(
        "{n} x {} ({} bytes), {cpus} logical CPUs, full={full:?}",
        src.display(),
        std::fs::metadata(&src).map_or(0, |m| m.len())
    );

    let mut combos = vec![
        (cpus, 0u32),
        (cpus, 1),
        (cpus, 2),
        (cpus / 2, 2),
        (cpus / 2, 4),
        (2, 4),
    ];
    combos.retain(|&(w, _)| w >= 1);
    combos.dedup();
    let opts = MediaOptions {
        full,
        ..Default::default()
    };
    for (workers, heic) in combos {
        let decoders: Vec<Box<dyn Decoder>> = default_decoders(heic);
        let t = Instant::now();
        let out = process_with(&report, &opts, &NoProgress, decoders, workers).expect("process");
        let s = t.elapsed().as_secs_f64();
        println!(
            "workers={workers:2} heic_threads={heic}: {s:7.2} s  {:6.1} files/s  => {:6.1} s per 1000  (failed {})",
            n as f64 / s,
            s / n as f64 * 1000.0,
            out.stats.failed
        );
    }

    let opts = MediaOptions {
        cache_dir: Some(dir.path().join("cache")),
        ..opts
    };
    for label in ["cold cache", "warm cache"] {
        let t = Instant::now();
        let out = process_with(&report, &opts, &NoProgress, default_decoders(1), cpus).expect("process");
        let s = t.elapsed().as_secs_f64();
        println!(
            "{label}: {s:7.2} s ({} decoded, {} cache hits)",
            out.stats.decoded, out.stats.cache_hits
        );
    }
}
