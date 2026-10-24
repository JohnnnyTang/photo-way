//! Throughput benchmark for the media pipeline (`cargo bench -p photoway-core --bench media`).
//!
//! Environment:
//! - `PW_BENCH_FILE`: image to replicate (default: the committed HEIC fixture; point it at a
//!   real 12 MP iPhone HEIC for meaningful numbers).
//! - `PW_BENCH_DIR`: directory of distinct HEICs (preferred for the 1,000-file target).
//! - `PW_BENCH_N`: number of files (default 64 for FILE; all files for DIR).
//! - `PW_BENCH_FULL`: `web` (default), `none` or `original`.
//!
//! For each (workers x libheif threads) combination it runs the full pipeline without a
//! cache and prints files/s plus the extrapolated time for 1,000 files. A single replicated
//! input only tests same-content deduplication in the cache run; use `PW_BENCH_DIR` to measure
//! realistic cold-cache throughput.

use std::path::PathBuf;
use std::time::Instant;

use photoway_core::NoProgress;
use photoway_core::media::{Decoder, FullSize, MediaOptions, default_decoders, process_with};
use photoway_core::meta::Meta;
use photoway_core::model::Kind;
use photoway_core::scan::{Entry, ScanReport};

fn main() {
    let supplied = std::env::var_os("PW_BENCH_FILE");
    let source_dir = std::env::var_os("PW_BENCH_DIR").map(PathBuf::from);
    assert!(
        source_dir.is_none() || supplied.is_none(),
        "set either PW_BENCH_DIR or PW_BENCH_FILE"
    );
    let src: PathBuf = supplied
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/sample-o6.heic"));
    let requested_n: Option<usize> = std::env::var("PW_BENCH_N").ok().and_then(|v| v.parse().ok());
    let full = match std::env::var("PW_BENCH_FULL").as_deref() {
        Ok("none") => FullSize::None,
        Ok("original") => FullSize::Original,
        _ => FullSize::Web,
    };

    let dir = tempfile::tempdir().expect("tempdir");
    let paths: Vec<PathBuf> = if let Some(ref source_dir) = source_dir {
        let mut paths: Vec<_> = std::fs::read_dir(source_dir)
            .expect("read PW_BENCH_DIR")
            .map(|entry| entry.expect("directory entry").path())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("heic") || ext.eq_ignore_ascii_case("heif"))
            })
            .collect();
        paths.sort();
        paths.truncate(requested_n.unwrap_or(paths.len()));
        paths
    } else {
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("heic");
        (0..requested_n.unwrap_or(64))
            .map(|i| {
                let path = dir.path().join(format!("img{i:05}.{ext}"));
                std::fs::copy(&src, &path).expect("copy");
                path
            })
            .collect()
    };
    assert!(!paths.is_empty(), "no HEIC inputs found");
    let n = paths.len();
    let entries: Vec<Entry> = paths
        .into_iter()
        .map(|path| Entry {
            path,
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
        })
        .collect();
    let report = ScanReport {
        entries,
        skipped: vec![],
    };
    let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
    println!(
        "{n} HEIC inputs from {}, {cpus} logical CPUs, full={full:?}",
        source_dir.as_deref().unwrap_or(&src).display(),
    );
    if supplied.is_none() && source_dir.is_none() {
        println!("Bundled HEIC is 640x480; these timings do not validate the 12 MP target.");
    }

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
