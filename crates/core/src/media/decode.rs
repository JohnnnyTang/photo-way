//! Decoder implementations: `image` crate (JPEG/PNG/TIFF), DNG preview, libheif (HEIC/HEIF).

use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageDecoder as _, ImageReader, RgbImage};

use super::{Decoder, anyhow_err, dng};
use crate::Result;

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

fn decode_with_orientation(reader: ImageReader<impl std::io::BufRead + std::io::Seek>) -> Result<RgbImage> {
    let mut decoder = reader.with_guessed_format()?.into_decoder().map_err(anyhow_err)?;
    let orientation = decoder.orientation().map_err(anyhow_err)?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(anyhow_err)?;
    img.apply_orientation(orientation);
    Ok(img.into_rgb8())
}

/// JPEG, PNG and TIFF through the `image` crate. The EXIF orientation is read from the file
/// and applied.
#[derive(Debug, Default, Clone, Copy)]
pub struct ImageDecoder;

impl Decoder for ImageDecoder {
    fn supports(&self, path: &Path) -> bool {
        matches!(ext_of(path).as_str(), "jpg" | "jpeg" | "png" | "tif" | "tiff")
    }

    fn decode(&self, path: &Path) -> Result<RgbImage> {
        decode_with_orientation(ImageReader::open(path)?)
    }
}

/// DNG: decodes the largest embedded preview JPEG (the raw sensor data is never touched).
/// Fails with a clear error when the file has no usable preview.
#[derive(Debug, Default, Clone, Copy)]
pub struct DngDecoder;

impl Decoder for DngDecoder {
    fn supports(&self, path: &Path) -> bool {
        ext_of(path) == "dng"
    }

    fn decode(&self, path: &Path) -> Result<RgbImage> {
        let data = std::fs::read(path)?;
        let preview = dng::find_preview(&data)
            .ok_or_else(|| anyhow_err("DNG has no embedded preview JPEG (raw decoding is not supported)"))?;
        for (off, len) in preview.candidates {
            let Some(bytes) = data.get(off..off.saturating_add(len)) else {
                continue;
            };
            let Ok(mut decoder) = ImageReader::new(Cursor::new(bytes))
                .with_guessed_format()
                .map_err(anyhow_err)
                .and_then(|r| r.into_decoder().map_err(anyhow_err))
            else {
                continue;
            };
            // Previews normally carry no EXIF; fall back to the IFD0 orientation tag.
            let own = decoder
                .orientation()
                .unwrap_or(image::metadata::Orientation::NoTransforms);
            let Ok(mut img) = DynamicImage::from_decoder(decoder) else {
                continue;
            };
            if own == image::metadata::Orientation::NoTransforms {
                let o = image::metadata::Orientation::from_exif(preview.orientation);
                img.apply_orientation(o.unwrap_or(image::metadata::Orientation::NoTransforms));
            } else {
                img.apply_orientation(own);
            }
            return Ok(img.into_rgb8());
        }
        Err(anyhow_err("DNG preview JPEG could not be decoded"))
    }
}

/// HEIC/HEIF through libheif. libheif applies `irot`/`imir`/`clap` itself, so the EXIF
/// orientation is deliberately **not** applied again.
#[cfg(feature = "heic")]
#[derive(Debug, Clone, Copy)]
pub struct HeifDecoder {
    threads: u32,
}

#[cfg(feature = "heic")]
impl HeifDecoder {
    /// `threads`: libheif tile-decoding threads per file. Use a small number (1-2) when many
    /// files are decoded in parallel, more for a single file.
    pub fn new(threads: u32) -> Self {
        Self { threads }
    }

    fn context(&self, path: &Path) -> Result<libheif_rs::HeifContext<'static>> {
        let name = path
            .to_str()
            .ok_or_else(|| anyhow_err("path is not valid UTF-8"))?;
        let mut ctx = libheif_rs::HeifContext::read_from_file(name).map_err(anyhow_err)?;
        ctx.set_max_decoding_threads(self.threads);
        Ok(ctx)
    }
}

#[cfg(feature = "heic")]
impl Default for HeifDecoder {
    fn default() -> Self {
        Self::new(2)
    }
}

#[cfg(feature = "heic")]
fn heif_to_rgb(handle: &libheif_rs::ImageHandle) -> Result<RgbImage> {
    use libheif_rs::{ColorSpace, LibHeif, RgbChroma};
    let image = LibHeif::new()
        .decode(handle, ColorSpace::Rgb(RgbChroma::Rgb), None)
        .map_err(anyhow_err)?;
    let planes = image.planes();
    let plane = planes
        .interleaved
        .ok_or_else(|| anyhow_err("libheif returned no interleaved RGB plane"))?;
    let (w, h) = (plane.width, plane.height);
    let row = w as usize * 3;
    let mut buf = Vec::with_capacity(row * h as usize);
    // Rows are `stride` bytes apart, which is not `width * 3`.
    for y in 0..h as usize {
        buf.extend_from_slice(&plane.data[y * plane.stride..y * plane.stride + row]);
    }
    RgbImage::from_raw(w, h, buf).ok_or_else(|| anyhow_err("bad RGB buffer from libheif"))
}

#[cfg(feature = "heic")]
impl Decoder for HeifDecoder {
    fn supports(&self, path: &Path) -> bool {
        matches!(ext_of(path).as_str(), "heic" | "heif" | "hif")
    }

    fn decode(&self, path: &Path) -> Result<RgbImage> {
        let ctx = self.context(path)?;
        let handle = ctx.primary_image_handle().map_err(anyhow_err)?;
        heif_to_rgb(&handle)
    }

    /// Uses the embedded thumbnail item when its short edge is at least `min_edge` and its
    /// orientation (portrait/landscape) agrees with the primary image.
    fn decode_thumb(&self, path: &Path, min_edge: u32) -> Result<Option<RgbImage>> {
        let ctx = self.context(path)?;
        let primary = ctx.primary_image_handle().map_err(anyhow_err)?;
        let n = primary.number_of_thumbnails();
        if n == 0 {
            return Ok(None);
        }
        let mut ids = vec![0; n];
        let n = primary.thumbnail_ids(&mut ids);
        let portrait = primary.height() > primary.width();
        for id in &ids[..n] {
            let Ok(t) = primary.thumbnail(*id) else { continue };
            if t.width().min(t.height()) < min_edge || (t.height() > t.width()) != portrait {
                continue;
            }
            if let Ok(img) = heif_to_rgb(&t) {
                return Ok(Some(img));
            }
        }
        Ok(None)
    }
}
