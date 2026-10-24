//! Neutral generated tiles used when no real thumbnail exists.

use std::sync::OnceLock;

use image::{Rgb, RgbImage};

use super::THUMB_SIZE;
use super::render::{THUMB_QUALITY, encode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Glyph {
    /// Dark tile with a play triangle (video without a poster frame).
    Play,
    /// Dark tile with a cross (file that could not be decoded).
    Broken,
}

pub(crate) fn thumbnail(glyph: Glyph) -> &'static [u8] {
    static PLAY: OnceLock<Vec<u8>> = OnceLock::new();
    static BROKEN: OnceLock<Vec<u8>> = OnceLock::new();
    let cell = match glyph {
        Glyph::Play => &PLAY,
        Glyph::Broken => &BROKEN,
    };
    cell.get_or_init(|| {
        let img = draw(glyph);
        encode(img.as_raw(), THUMB_SIZE, THUMB_SIZE, THUMB_QUALITY).expect("encoding a 256x256 tile")
    })
}

fn draw(glyph: Glyph) -> RgbImage {
    let s = THUMB_SIZE as f32;
    let (bg, fg) = (Rgb([38, 42, 50]), Rgb([200, 205, 214]));
    RgbImage::from_fn(THUMB_SIZE, THUMB_SIZE, |x, y| {
        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
        let on = match glyph {
            Glyph::Play => {
                // Right-pointing triangle centered slightly right of the middle.
                let (l, r) = (s * 0.40, s * 0.66);
                let half = (s * 0.17) * (r - px) / (r - l);
                px >= l && px <= r && (py - s / 2.0).abs() <= half
            }
            Glyph::Broken => {
                let (a, b) = (px - s / 2.0, py - s / 2.0);
                a.abs() <= s * 0.16 && b.abs() <= s * 0.16 && ((a - b).abs() <= 5.0 || (a + b).abs() <= 5.0)
            }
        };
        if on { fg } else { bg }
    })
}
