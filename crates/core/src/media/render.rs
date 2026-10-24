//! Resizing and JPEG encoding. Output JPEGs never carry EXIF/ICC metadata.

use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::RgbImage;

use super::{THUMB_SIZE, anyhow_err};
use crate::Result;

pub(crate) const THUMB_QUALITY: u8 = 78;
pub(crate) const WEB_QUALITY: u8 = 85;

fn options() -> ResizeOptions {
    // Hamming is sharp enough for large downscales and noticeably faster than Lanczos.
    ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Hamming))
}

fn resize(img: &RgbImage, dst: &mut Image, opts: &ResizeOptions) -> Result<()> {
    let src = ImageRef::new(img.width(), img.height(), img.as_raw(), PixelType::U8x3).map_err(anyhow_err)?;
    Resizer::new().resize(&src, dst, opts).map_err(anyhow_err)?;
    Ok(())
}

/// Square `THUMB_SIZE` thumbnail: center crop, then resize (upscales tiny sources).
pub(crate) fn thumbnail(img: &RgbImage) -> Result<Vec<u8>> {
    let mut dst = Image::new(THUMB_SIZE, THUMB_SIZE, PixelType::U8x3);
    resize(img, &mut dst, &options().fit_into_destination(Some((0.5, 0.5))))?;
    encode(dst.buffer(), THUMB_SIZE, THUMB_SIZE, THUMB_QUALITY)
}

/// Re-encode with the long edge limited to `long_edge` (never upscaled).
pub(crate) fn web(img: &RgbImage, long_edge: u32) -> Result<Vec<u8>> {
    let (w, h) = img.dimensions();
    let long = w.max(h);
    if long <= long_edge {
        return encode(img.as_raw(), w, h, WEB_QUALITY);
    }
    let scale = f64::from(long_edge) / f64::from(long);
    let nw = ((f64::from(w) * scale).round() as u32).max(1);
    let nh = ((f64::from(h) * scale).round() as u32).max(1);
    let mut dst = Image::new(nw, nh, PixelType::U8x3);
    resize(img, &mut dst, &options())?;
    encode(dst.buffer(), nw, nh, WEB_QUALITY)
}

pub(crate) fn encode(rgb: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>> {
    let (w16, h16) = match (u16::try_from(w), u16::try_from(h)) {
        (Ok(w), Ok(h)) => (w, h),
        _ => return Err(anyhow_err(format!("image too large for JPEG: {w}x{h}"))),
    };
    let mut out = Vec::with_capacity(rgb.len() / 8);
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(rgb, w16, h16, jpeg_encoder::ColorType::Rgb)
        .map_err(anyhow_err)?;
    Ok(out)
}
