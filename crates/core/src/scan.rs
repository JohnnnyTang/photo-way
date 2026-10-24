//! Walk input paths and classify media files. Owner: Wave 1 · A.

use std::path::{Path, PathBuf};

use crate::meta::Meta;
use crate::{Error, Progress, Result};

pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "dng"];
pub const VIDEO_EXTS: &[&str] = &["mov", "mp4", "m4v"];

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    /// Descend into sub-directories of input folders.
    pub recursive: bool,
    /// Pair HEIC/JPEG stills with same-named MOV clips into `Kind::Live`.
    pub pair_live_photos: bool,
}

/// One usable (geotagged) media entry found by [`scan`].
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: PathBuf,
    /// Motion clip of a Live Photo, if paired.
    pub motion: Option<PathBuf>,
    pub meta: Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    NoLocation,
    Unreadable,
    Unsupported,
    Duplicate,
}

#[derive(Debug, Clone, Default)]
pub struct ScanReport {
    /// Sorted by capture instant (unknown last).
    pub entries: Vec<Entry>,
    pub skipped: Vec<(PathBuf, SkipReason)>,
}

pub fn is_media(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            IMAGE_EXTS.contains(&e.as_str()) || VIDEO_EXTS.contains(&e.as_str())
        })
        .unwrap_or(false)
}

pub fn scan(_inputs: &[PathBuf], _opts: &ScanOptions, _progress: &dyn Progress) -> Result<ScanReport> {
    Err(Error::Unimplemented("scan::scan"))
}
