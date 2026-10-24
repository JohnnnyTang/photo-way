//! `photoway` — build and serve portable photo route maps.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};

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

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Build { .. } | Command::Inspect { .. } | Command::Serve { .. } => {
            anyhow::bail!("not implemented yet (Wave 2 · E)")
        }
    }
}
