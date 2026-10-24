//! Decode images, render thumbnails and web-sized copies. Owner: Wave 1 · B.

use std::path::{Path, PathBuf};

use crate::scan::ScanReport;
use crate::{Error, Progress, Result};

pub const THUMB_SIZE: u32 = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FullSize {
    /// Thumbnails only.
    None,
    /// Re-encoded JPEG, long edge in pixels, EXIF stripped.
    #[default]
    Web,
    /// Original files copied as-is.
    Original,
}

#[derive(Debug, Clone)]
pub struct MediaOptions {
    pub full: FullSize,
    /// Long edge for `FullSize::Web` (1280–4096).
    pub web_long_edge: u32,
    /// Include video / Live Photo motion files.
    pub include_video: bool,
    /// Content-hash cache directory; `None` disables caching.
    pub cache_dir: Option<PathBuf>,
}

impl Default for MediaOptions {
    fn default() -> Self {
        Self {
            full: FullSize::Web,
            web_long_edge: 2048,
            include_video: true,
            cache_dir: None,
        }
    }
}

/// Processed media for one scan entry (same index as `ScanReport::entries`).
#[derive(Debug, Clone)]
pub struct Rendered {
    pub thumb_jpeg: Vec<u8>,
    pub full: Option<Asset>,
    pub video: Option<Asset>,
}

#[derive(Debug, Clone)]
pub enum Asset {
    Bytes { data: Vec<u8>, ext: &'static str },
    File(PathBuf),
}

#[derive(Debug, Clone, Default)]
pub struct Prepared {
    pub rendered: Vec<Rendered>,
}

/// Image decoding backend (image crate, libheif, platform codecs).
pub trait Decoder: Send + Sync {
    fn supports(&self, path: &Path) -> bool;
    /// Decode to RGB8 with orientation applied.
    fn decode(&self, path: &Path) -> Result<image::RgbImage>;
}

pub fn process(_report: &ScanReport, _opts: &MediaOptions, _progress: &dyn Progress) -> Result<Prepared> {
    Err(Error::Unimplemented("media::process"))
}
