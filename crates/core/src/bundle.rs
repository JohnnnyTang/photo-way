//! Write projects as single HTML, folder, or zip. Owner: Wave 2 · E.
//!
//! Signatures here are frozen for Wave 2 (the app and the E2E suite build against them).
//! Flow: `scan` → `media::process` → [`project`] → [`estimate`] / [`write`].

use std::path::{Path, PathBuf};

use crate::media::{Asset, Prepared};
use crate::model::{Project, ProjectOptions};
use crate::scan::ScanReport;
use crate::{Error, Progress, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Html,
    Dir,
    Zip,
}

/// Per-export choices that are not media rendering (those live in `media::MediaOptions`).
#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub title: String,
    pub options: ProjectOptions,
    /// Round `lat`/`lon` to this many decimal places; `None` keeps full precision.
    pub coord_decimals: Option<u8>,
    /// Strip EXIF/XMP from images copied as originals (web-sized images never carry it).
    pub strip_exif: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            title: "Photo Way".into(),
            options: ProjectOptions::default(),
            coord_decimals: None,
            strip_exif: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WriteReport {
    pub path: PathBuf,
    pub bytes: u64,
}

/// Builds the project document. Refs use the bundle layout (`thumbs/00000.jpg`,
/// `media/00000-<safe-name>.<ext>`); [`write`] rewrites them to pack refs for [`Format::Html`].
/// Generates a fresh `id` and `createdAt`; `items[i].id == i` in `report.entries` order.
pub fn project(_report: &ScanReport, _prepared: &Prepared, _opts: &ExportOptions) -> Project {
    unimplemented!("bundle::project (Wave 2 · E)")
}

/// The asset behind a bundle-layout ref of `project`, e.g. for the app's preview protocol.
/// Returns `None` for unknown refs.
pub fn asset_for_ref<'a>(_prepared: &'a Prepared, _project: &Project, _rel: &str) -> Option<&'a Asset> {
    None
}

/// Estimated output size in bytes, without writing anything.
pub fn estimate(_prepared: &Prepared, _project: &Project, _format: Format, _opts: &ExportOptions) -> u64 {
    0
}

/// Writes `project` to `out` (an `.html` file, a directory, or a `.zip` file).
pub fn write(
    _prepared: &Prepared,
    _project: &Project,
    _format: Format,
    _out: &Path,
    _opts: &ExportOptions,
    _progress: &dyn Progress,
) -> Result<WriteReport> {
    Err(Error::Unimplemented("bundle::write"))
}
