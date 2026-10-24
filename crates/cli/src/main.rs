//! `photoway` — build and serve portable photo route maps.

use std::io::{IsTerminal, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use clap::{Parser, Subcommand, ValueEnum};
use photoway_core::bundle::{self, ExportOptions, Format};
use photoway_core::media::{self, FullSize, MediaOptions};
use photoway_core::model::{Basemap, Kind, ProjectOptions};
use photoway_core::scan::{self, ScanOptions, SkipReason};
use photoway_core::{NoProgress, Progress, serve};

#[derive(Parser)]
#[command(
    name = "photoway",
    version,
    about = "Turn geotagged photos into a portable route map"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan photos and write a map (single HTML, folder, or zip).
    Build {
        /// Photo files or folders.
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// Output path (`.html`, folder, or `.zip`).
        #[arg(short, long)]
        out: PathBuf,
        #[arg(long, value_enum, default_value_t = OutFormat::Html)]
        format: OutFormat,
        #[arg(long, default_value = "Photo Way")]
        title: String,
        /// Full-size media to include next to the thumbnails.
        #[arg(long, value_enum, default_value_t = FullArg::Web)]
        full: FullArg,
        /// Long edge in pixels for `--full web` (1280-4096).
        #[arg(long, default_value_t = 2048)]
        web_edge: u32,
        /// Leave out video and Live Photo motion clips.
        #[arg(long)]
        no_video: bool,
        /// Keep EXIF in images copied with `--full original`.
        #[arg(long)]
        keep_exif: bool,
        /// Round coordinates to this many decimal places.
        #[arg(long)]
        coord_decimals: Option<u8>,
        /// Cache directory for rendered media (makes re-exports fast).
        #[arg(long)]
        cache: Option<PathBuf>,
        /// Default theme of the exported viewer (auto, light, dark, dusk, paper, forest).
        #[arg(long, default_value = "auto")]
        theme: String,
        /// Default basemap (auto, offline, satellite, satellite-labels, topo, osm, terrain).
        #[arg(long, default_value = "auto")]
        basemap: String,
    },
    /// Serve an exported folder, zip, or HTML file on localhost.
    ///
    /// The first stdout line is `Serving <path> at <url>`; port 0 picks a free port.
    Serve {
        path: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8765")]
        addr: SocketAddr,
    },
    /// Print what a scan finds without writing anything.
    Inspect {
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// Machine-readable output: `{"entries":[...],"skipped":[{"path","reason"}]}`.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum OutFormat {
    Html,
    Dir,
    Zip,
}

#[derive(Clone, Copy, ValueEnum)]
enum FullArg {
    None,
    Web,
    Original,
}

/// Writes throttled progress lines to stderr; stdout stays clean for results.
struct StderrProgress {
    phase: &'static str,
    last: Mutex<Instant>,
    tty: bool,
}

impl StderrProgress {
    fn new(phase: &'static str) -> Self {
        Self {
            phase,
            last: Mutex::new(Instant::now() - Duration::from_secs(10)),
            tty: std::io::stderr().is_terminal(),
        }
    }

    fn finish(&self) {
        if self.tty {
            eprintln!();
        }
    }
}

impl Progress for StderrProgress {
    fn update(&self, done: u64, total: u64, label: &str) {
        if total == 0 {
            return;
        }
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        let interval = if self.tty { 100 } else { 2000 };
        if done < total && last.elapsed() < Duration::from_millis(interval) {
            return;
        }
        *last = Instant::now();
        let line = format!("{}: {done}/{total} {label}", self.phase);
        if self.tty {
            eprint!("{}{line:<79}", char::from(13u8));
        } else {
            eprintln!("{line}");
        }
    }
}

fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[unit])
    }
}

fn reason_name(r: SkipReason) -> &'static str {
    match r {
        SkipReason::NoLocation => "no-location",
        SkipReason::Unreadable => "unreadable",
        SkipReason::Unsupported => "unsupported",
        SkipReason::Duplicate => "duplicate",
    }
}

fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Photo => "photo",
        Kind::Video => "video",
        Kind::Live => "live",
    }
}

const THEMES: [&str; 6] = ["auto", "light", "dark", "dusk", "paper", "forest"];

fn parse_basemap(s: &str) -> Result<Basemap> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).map_err(|_| {
        anyhow!("unknown basemap '{s}' (auto, offline, satellite, satellite-labels, topo, osm, terrain)")
    })
}

#[allow(clippy::too_many_arguments)]
fn build(
    inputs: Vec<PathBuf>,
    out: PathBuf,
    format: OutFormat,
    title: String,
    full: FullArg,
    web_edge: u32,
    no_video: bool,
    keep_exif: bool,
    coord_decimals: Option<u8>,
    cache: Option<PathBuf>,
    theme: String,
    basemap: String,
) -> Result<()> {
    if !THEMES.contains(&theme.as_str()) {
        bail!("unknown theme '{theme}' ({})", THEMES.join(", "));
    }
    let basemap = parse_basemap(&basemap)?;
    let (lo, hi) = media::WEB_EDGE_RANGE;
    if !(lo..=hi).contains(&web_edge) {
        bail!("--web-edge must be between {lo} and {hi}");
    }

    let p = StderrProgress::new("scan");
    let report = scan::scan(&inputs, &ScanOptions::default(), &p)?;
    p.finish();
    if report.entries.is_empty() {
        bail!(
            "no photos with a location found ({} files skipped)",
            report.skipped.len()
        );
    }

    let media_opts = MediaOptions {
        full: match full {
            FullArg::None => FullSize::None,
            FullArg::Web => FullSize::Web,
            FullArg::Original => FullSize::Original,
        },
        web_long_edge: web_edge,
        include_video: !no_video,
        cache_dir: cache,
    };
    let p = StderrProgress::new("render");
    let prepared = media::process(&report, &media_opts, &p)?;
    p.finish();
    for e in &prepared.errors {
        eprintln!("warning: {}: {}", e.path.display(), e.message);
    }

    let export = ExportOptions {
        title,
        options: ProjectOptions {
            theme,
            basemap,
            ..ProjectOptions::default()
        },
        coord_decimals,
        strip_exif: !keep_exif,
    };
    let project = bundle::project(&report, &prepared, &export);
    let fmt = match format {
        OutFormat::Html => Format::Html,
        OutFormat::Dir => Format::Dir,
        OutFormat::Zip => Format::Zip,
    };
    let p = StderrProgress::new("write");
    let written = bundle::write(&prepared, &project, fmt, &out, &export, &p)?;
    p.finish();

    let count = |k: Kind| project.items.iter().filter(|i| i.kind == k).count();
    println!(
        "Items: {} ({} photos, {} videos, {} live photos)",
        project.items.len(),
        count(Kind::Photo),
        count(Kind::Video),
        count(Kind::Live)
    );
    println!("Skipped: {}", report.skipped.len());
    println!(
        "Output: {} ({})",
        written.path.display(),
        format_bytes(written.bytes)
    );
    Ok(())
}

fn inspect(inputs: Vec<PathBuf>, json: bool) -> Result<()> {
    let report = scan::scan(&inputs, &ScanOptions::default(), &NoProgress)?;
    if json {
        let entries: Vec<_> = report
            .entries
            .iter()
            .map(|e| {
                let m = &e.meta;
                serde_json::json!({
                    "path": e.path,
                    "motion": e.motion,
                    "kind": kind_name(m.kind),
                    "lat": m.lat,
                    "lon": m.lon,
                    "alt": m.alt,
                    "time": m.time,
                    "ts": m.ts,
                    "tsSource": m.ts_source,
                    "day": m.day,
                    "w": m.w,
                    "h": m.h,
                    "dur": m.dur,
                })
            })
            .collect();
        let skipped: Vec<_> = report
            .skipped
            .iter()
            .map(|(path, reason)| serde_json::json!({ "path": path, "reason": reason_name(*reason) }))
            .collect();
        println!(
            "{}",
            serde_json::json!({ "entries": entries, "skipped": skipped })
        );
    } else {
        for e in &report.entries {
            let m = &e.meta;
            println!(
                "{}\t{}\t{:.6}, {:.6}\t{}",
                kind_name(m.kind),
                m.time.as_deref().unwrap_or("-"),
                m.lat,
                m.lon,
                e.path.display()
            );
        }
        for (path, reason) in &report.skipped {
            println!("skipped ({})\t{}", reason_name(*reason), path.display());
        }
        println!(
            "{} usable, {} skipped",
            report.entries.len(),
            report.skipped.len()
        );
    }
    Ok(())
}

fn serve_cmd(path: PathBuf, addr: SocketAddr) -> Result<()> {
    let handle = serve::serve(&path, addr)?;
    let mut stdout = std::io::stdout();
    writeln!(stdout, "Serving {} at {}", path.display(), handle.url())?;
    stdout.flush()?;
    handle.wait();
    Ok(())
}

fn run() -> Result<()> {
    match Cli::parse().command {
        Command::Build {
            inputs,
            out,
            format,
            title,
            full,
            web_edge,
            no_video,
            keep_exif,
            coord_decimals,
            cache,
            theme,
            basemap,
        } => build(
            inputs,
            out,
            format,
            title,
            full,
            web_edge,
            no_video,
            keep_exif,
            coord_decimals,
            cache,
            theme,
            basemap,
        ),
        Command::Serve { path, addr } => serve_cmd(path, addr),
        Command::Inspect { inputs, json } => inspect(inputs, json),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
