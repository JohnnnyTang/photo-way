//! Decode images, render thumbnails and web-sized copies. Owner: Wave 1 · B.
//!
//! # Pipeline
//!
//! [`process`] turns a [`ScanReport`] into a [`Prepared`] whose `rendered[i]` belongs to
//! `report.entries[i]`. Per entry:
//!
//! - **Photo / Live still**: decoded once (HEIC, JPEG, PNG, TIFF, DNG preview), then a
//!   [`THUMB_SIZE`] center-cropped square thumbnail (JPEG q78) and, for [`FullSize::Web`],
//!   a long-edge-limited JPEG (q85, never upscaled, no EXIF) are rendered.
//!   [`FullSize::Original`] passes the source file through as [`Asset::File`].
//! - **Video** (`Kind::Video`): no decoding in core. The thumbnail is the *poster frame*
//!   registered with [`set_poster`], or a generated placeholder tile.
//! - **Live Photo motion clip** (and video files): `video` is `Asset::File` when
//!   [`MediaOptions::include_video`] is set.
//!
//! # Errors
//!
//! A bad file never aborts the batch: its `Rendered` gets a placeholder thumbnail and no
//! `full`, and a [`ItemError`] is appended to [`Prepared::errors`]. Only cancellation
//! ([`Error::Cancelled`]) aborts the whole call.
//!
//! # Cache
//!
//! With `cache_dir` set, thumbnails and web previews are cached by content key (see
//! `cache.rs`); unchanged inputs are not decoded again ([`Stats::cache_hits`]). Corrupt
//! entries are ignored and rewritten.
//!
//! # Poster frames (video thumbnails)
//!
//! Core has no video decoder. The app captures a frame in the webview (e.g. draw the
//! `<video>` to a canvas, `toBlob('image/jpeg')`) and hands the bytes over with
//! [`set_poster`] before or while [`process`] runs; the poster is stored in the same
//! content-hash cache directory and picked up by `process` (it is looked up per item right
//! before rendering, so posters registered while a run is in progress are used when the
//! item has not been rendered yet). Posters need `cache_dir`; without it every video gets the
//! placeholder tile. [`has_poster`] tells the UI which videos still need a frame.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use image::RgbImage;
use rayon::prelude::*;

use crate::model::Kind;
use crate::scan::{Entry, ScanReport};
use crate::{Error, Progress, Result};

mod cache;
mod decode;
mod dng;
mod placeholder;
mod render;

use cache::Cache;
#[cfg(feature = "heic")]
pub use decode::HeifDecoder;
pub use decode::{DngDecoder, ImageDecoder};
use placeholder::Glyph;

pub const THUMB_SIZE: u32 = 256;

/// Smallest and largest accepted `web_long_edge`.
pub const WEB_EDGE_RANGE: (u32, u32) = (1280, 4096);

const POSTER_TAG: &str = "poster256";

/// Shortest edge of an embedded thumbnail that is accepted instead of a full decode.
/// 7/8 of `THUMB_SIZE` admits the 320x240 thumbnails iPhones write (an upscale of at most
/// 7%) while rejecting anything visibly soft.
const EMBEDDED_THUMB_MIN: u32 = THUMB_SIZE * 7 / 8;

pub(crate) fn anyhow_err(e: impl std::fmt::Display) -> Error {
    Error::Other(anyhow::anyhow!("{e}"))
}

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
    /// Long edge for `FullSize::Web`, clamped to [`WEB_EDGE_RANGE`] (1280-4096).
    pub web_long_edge: u32,
    /// Include video / Live Photo motion files.
    pub include_video: bool,
    /// Content-hash cache directory; `None` disables caching (and video posters).
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

/// A file that could not be rendered; its `Rendered` holds a placeholder thumbnail.
#[derive(Debug, Clone)]
pub struct ItemError {
    /// Index into `ScanReport::entries`.
    pub index: usize,
    pub path: PathBuf,
    pub message: String,
}

/// Counters for diagnostics and tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    /// Full-resolution decodes performed.
    pub decoded: usize,
    /// Thumbnails produced from an embedded thumbnail instead of a full decode.
    pub embedded_thumbs: usize,
    /// Items that needed no decoding because everything came from the cache.
    pub cache_hits: usize,
    /// Items that failed (see [`Prepared::errors`]).
    pub failed: usize,
}

#[derive(Debug, Clone, Default)]
pub struct Prepared {
    pub rendered: Vec<Rendered>,
    /// Per-item failures; the batch still completes.
    pub errors: Vec<ItemError>,
    pub stats: Stats,
}

/// Image decoding backend (image crate, libheif, platform codecs).
pub trait Decoder: Send + Sync {
    fn supports(&self, path: &Path) -> bool;
    /// Decode to RGB8 with orientation applied.
    fn decode(&self, path: &Path) -> Result<RgbImage>;
    /// A cheap, oriented image whose short edge is at least `min_edge`, if the format has
    /// one available without a full decode (e.g. a HEIC thumbnail item). Default: none.
    fn decode_thumb(&self, _path: &Path, _min_edge: u32) -> Result<Option<RgbImage>> {
        Ok(None)
    }
}

/// The built-in decoders, in lookup order. `heic_threads` is libheif's per-file decoding
/// thread count (ignored without the `heic` feature).
pub fn default_decoders(heic_threads: u32) -> Vec<Box<dyn Decoder>> {
    #[cfg(not(feature = "heic"))]
    let _ = heic_threads;
    vec![
        #[cfg(feature = "heic")]
        Box::new(HeifDecoder::new(heic_threads)),
        Box::new(DngDecoder),
        Box::new(ImageDecoder),
    ]
}

/// Register a poster frame (PNG or JPEG bytes) for a video, to be used as its thumbnail.
///
/// The frame is center-cropped to a [`THUMB_SIZE`] square and stored in `cache_dir` under
/// the video's content key. Safe to call from any thread, before or during [`process`].
pub fn set_poster(cache_dir: &Path, video: &Path, image_bytes: &[u8]) -> Result<()> {
    let img = image::load_from_memory(image_bytes)
        .map_err(anyhow_err)?
        .into_rgb8();
    let key = cache::content_key(video)?;
    Cache::new(cache_dir).put(&key, POSTER_TAG, &render::thumbnail(&img)?);
    Ok(())
}

/// Whether [`set_poster`] already stored a frame for this video.
pub fn has_poster(cache_dir: &Path, video: &Path) -> bool {
    cache::content_key(video).is_ok_and(|key| Cache::new(cache_dir).contains(&key, POSTER_TAG))
}

/// Render every entry of `report` (see the module docs).
pub fn process(report: &ScanReport, opts: &MediaOptions, progress: &dyn Progress) -> Result<Prepared> {
    let total = report.entries.len();
    let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
    // Each worker decodes one file at a time; libheif gets extra tile threads only when
    // there are fewer files than workers (tuned with `benches/media.rs`).
    let heic_threads = if total >= cpus { 1 } else { 2 };
    process_with(report, opts, progress, default_decoders(heic_threads), cpus)
}

/// Like [`process`] with explicit decoders and a worker-thread count (benchmarks, tests,
/// platform codecs).
pub fn process_with(
    report: &ScanReport,
    opts: &MediaOptions,
    progress: &dyn Progress,
    decoders: Vec<Box<dyn Decoder>>,
    threads: usize,
) -> Result<Prepared> {
    let total = report.entries.len();
    let ctx = Ctx {
        decoders,
        cache: opts.cache_dir.as_deref().map(Cache::new),
        opts,
        decoded: AtomicUsize::new(0),
        embedded: AtomicUsize::new(0),
        hits: AtomicUsize::new(0),
    };
    let done = AtomicU64::new(0);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads.min(total.max(1)))
        .build()
        .map_err(anyhow_err)?;

    let results: Vec<(Rendered, Option<ItemError>)> = pool.install(|| {
        report
            .entries
            .par_iter()
            .enumerate()
            .map(|(index, entry)| {
                if progress.cancelled() {
                    return Err(Error::Cancelled);
                }
                let out = match ctx.render(entry) {
                    Ok(r) => (r, None),
                    Err(e) => (
                        Rendered {
                            thumb_jpeg: placeholder::thumbnail(Glyph::Broken).to_vec(),
                            full: None,
                            video: ctx.video_asset(entry),
                        },
                        Some(ItemError {
                            index,
                            path: entry.path.clone(),
                            message: e.to_string(),
                        }),
                    ),
                };
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                let label = entry
                    .path
                    .file_name()
                    .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
                progress.update(n, total as u64, &label);
                Ok(out)
            })
            .collect::<Result<Vec<_>>>()
    })?;

    let mut prepared = Prepared::default();
    for (rendered, err) in results {
        prepared.rendered.push(rendered);
        prepared.errors.extend(err);
    }
    prepared.stats = Stats {
        decoded: ctx.decoded.load(Ordering::Relaxed),
        embedded_thumbs: ctx.embedded.load(Ordering::Relaxed),
        cache_hits: ctx.hits.load(Ordering::Relaxed),
        failed: prepared.errors.len(),
    };
    Ok(prepared)
}

struct Ctx<'a> {
    decoders: Vec<Box<dyn Decoder>>,
    cache: Option<Cache>,
    opts: &'a MediaOptions,
    decoded: AtomicUsize,
    embedded: AtomicUsize,
    hits: AtomicUsize,
}

impl Ctx<'_> {
    fn web_edge(&self) -> u32 {
        self.opts.web_long_edge.clamp(WEB_EDGE_RANGE.0, WEB_EDGE_RANGE.1)
    }

    fn thumb_tag() -> String {
        format!("t{THUMB_SIZE}q{}", render::THUMB_QUALITY)
    }

    fn web_tag(&self) -> String {
        format!("w{}q{}", self.web_edge(), render::WEB_QUALITY)
    }

    fn video_asset(&self, entry: &Entry) -> Option<Asset> {
        if !self.opts.include_video {
            return None;
        }
        match entry.meta.kind {
            Kind::Video => Some(Asset::File(entry.path.clone())),
            _ => entry.motion.clone().map(Asset::File),
        }
    }

    fn render(&self, entry: &Entry) -> Result<Rendered> {
        let video = self.video_asset(entry);
        if entry.meta.kind == Kind::Video {
            return Ok(Rendered {
                thumb_jpeg: self.poster_or_placeholder(&entry.path),
                full: None,
                video,
            });
        }
        let (thumb_jpeg, web) = self.render_image(&entry.path)?;
        let full = match self.opts.full {
            FullSize::None => None,
            FullSize::Original => Some(Asset::File(entry.path.clone())),
            FullSize::Web => web.map(|data| Asset::Bytes { data, ext: "jpg" }),
        };
        Ok(Rendered {
            thumb_jpeg,
            full,
            video,
        })
    }

    fn poster_or_placeholder(&self, video: &Path) -> Vec<u8> {
        self.cache
            .as_ref()
            .and_then(|c| c.get(&cache::content_key(video).ok()?, POSTER_TAG))
            .unwrap_or_else(|| placeholder::thumbnail(Glyph::Play).to_vec())
    }

    /// Returns `(thumbnail, web preview if requested)`.
    fn render_image(&self, path: &Path) -> Result<(Vec<u8>, Option<Vec<u8>>)> {
        let want_web = self.opts.full == FullSize::Web;
        let key = self.cache.as_ref().and_then(|_| cache::content_key(path).ok());
        let cached = |tag: &str| match (&self.cache, &key) {
            (Some(c), Some(k)) => c.get(k, tag),
            _ => None,
        };
        let store = |tag: &str, data: &[u8]| {
            if let (Some(c), Some(k)) = (&self.cache, &key) {
                c.put(k, tag, data);
            }
        };
        let (thumb_tag, web_tag) = (Self::thumb_tag(), self.web_tag());

        let mut thumb = cached(&thumb_tag);
        let mut web = if want_web { cached(&web_tag) } else { None };
        if thumb.is_some() && (!want_web || web.is_some()) {
            self.hits.fetch_add(1, Ordering::Relaxed);
            return Ok((thumb.unwrap_or_default(), web));
        }

        let decoder = self
            .decoders
            .iter()
            .find(|d| d.supports(path))
            .ok_or_else(|| anyhow_err("unsupported file type"))?;

        // Thumbnail only: try the format's cheap embedded thumbnail first.
        if thumb.is_none()
            && !want_web
            && let Some(small) = decoder.decode_thumb(path, EMBEDDED_THUMB_MIN)?
        {
            self.embedded.fetch_add(1, Ordering::Relaxed);
            let t = render::thumbnail(&small)?;
            store(&thumb_tag, &t);
            return Ok((t, None));
        }

        let img = decoder.decode(path)?;
        self.decoded.fetch_add(1, Ordering::Relaxed);
        if thumb.is_none() {
            let t = render::thumbnail(&img)?;
            store(&thumb_tag, &t);
            thumb = Some(t);
        }
        if want_web && web.is_none() {
            let w = render::web(&img, self.web_edge())?;
            store(&web_tag, &w);
            web = Some(w);
        }
        Ok((thumb.unwrap_or_default(), web))
    }
}
