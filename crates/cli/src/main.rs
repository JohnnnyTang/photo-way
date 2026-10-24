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
    },
    /// Serve an exported folder, zip, or HTML file on localhost.
    Serve {
        path: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8765")]
        addr: SocketAddr,
    },
    /// Print what a scan finds without writing anything.
    Inspect {
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum OutFormat {
    Html,
    Dir,
    Zip,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Build { .. } | Command::Inspect { .. } | Command::Serve { .. } => {
            anyhow::bail!("not implemented yet (Wave 2 · E)")
        }
    }
}
