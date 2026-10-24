//! Spike S1: decode HEIC -> RGB, center-crop + resize to 256x256, write JPEG.
//!
//! Usage:
//!   heic-spike <in.heic|in.jpg> <out.jpg> [--expect <quadrant>]
//!   heic-spike gen <out.jpg> <exif-orientation 1..8>   (synthetic 4032x3024 test JPEG)
//!   heic-spike info                                     (libheif version + decoders)
//!
//! `--expect` checks which quadrant of the *decoded, oriented* image is red
//! (the generator paints the stored top-left quadrant red), so CI can assert
//! that orientation/transformations were honoured.

use std::error::Error;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{PixelType, ResizeOptions, Resizer};
use image::codecs::jpeg::JpegEncoder;
use image::{ImageDecoder, RgbImage};

type Res<T> = Result<T, Box<dyn Error>>;

const THUMB: u32 = 256;
const RUNS: usize = 3;

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Res<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("gen") if args.len() == 3 => gen(&args[1], args[2].parse()?),
        Some("info") => info(),
        Some(_) if args.len() >= 2 => {
            let expect = match args.get(2).map(String::as_str) {
                Some("--expect") => args.get(3).cloned(),
                _ => None,
            };
            convert(&args[0], &args[1], expect.as_deref())
        }
        _ => {
            eprintln!(
                "usage: heic-spike <in.heic> <out.jpg> [--expect <quadrant>]\n       \
                 heic-spike gen <out.jpg> <orientation>\n       heic-spike info"
            );
            std::process::exit(2);
        }
    }
}

fn convert(input: &str, output: &str, expect: Option<&str>) -> Res<()> {
    let is_heif = matches!(
        Path::new(input)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("heic" | "heif" | "hif")
    );

    let mut times = Vec::with_capacity(RUNS);
    let mut decoded = None;
    for _ in 0..RUNS {
        let t = Instant::now();
        let img = if is_heif { decode_heif(input)? } else { decode_image(input)? };
        times.push(t.elapsed());
        decoded = Some(img);
    }
    let img = decoded.unwrap();
    let best = times.iter().min().copied().unwrap_or_default();
    println!(
        "decoded {input}: {}x{} (backend: {}) decode first={} best={} (of {RUNS})",
        img.width(),
        img.height(),
        if is_heif { "libheif" } else { "image" },
        ms(times[0]),
        ms(best),
    );

    let quadrant = red_quadrant(&img);
    println!("red quadrant (orientation check): {quadrant}");

    let t = Instant::now();
    let thumb = thumbnail(img)?;
    let resize_time = t.elapsed();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 78).encode_image(&thumb)?;
    fs::write(output, &jpeg)?;
    println!(
        "wrote {output}: {}x{} {} bytes (crop+resize {})",
        thumb.width(),
        thumb.height(),
        jpeg.len(),
        ms(resize_time)
    );

    if let Some(want) = expect {
        if want != quadrant {
            return Err(format!("orientation check FAILED: expected red {want}, got {quadrant}").into());
        }
        println!("orientation check OK");
    }
    Ok(())
}

fn ms(d: Duration) -> String {
    format!("{:.1}ms", d.as_secs_f64() * 1000.0)
}

/// Center-crop to a square and resize to THUMB x THUMB.
fn thumbnail(img: RgbImage) -> Res<RgbImage> {
    let (w, h) = img.dimensions();
    let src = FirImage::from_vec_u8(w, h, img.into_raw(), PixelType::U8x3)?;
    let mut dst = FirImage::new(THUMB, THUMB, PixelType::U8x3);
    Resizer::new().resize(&src, &mut dst, &ResizeOptions::new().fit_into_destination(Some((0.5, 0.5))))?;
    Ok(RgbImage::from_raw(THUMB, THUMB, dst.into_vec()).ok_or("bad thumbnail buffer")?)
}

/// Decode with the `image` crate and apply EXIF orientation.
fn decode_image(path: &str) -> Res<RgbImage> {
    let mut decoder = image::ImageReader::open(path)?.with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut img = image::DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img.into_rgb8())
}

#[cfg(feature = "heic")]
fn decode_heif(path: &str) -> Res<RgbImage> {
    use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};
    let lib = LibHeif::new();
    let ctx = HeifContext::read_from_file(path)?;
    let handle = ctx.primary_image_handle()?;
    // decode() applies irot/imir/clap transformations (ignore_transformations = false).
    let image = lib.decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None)?;
    let planes = image.planes();
    let plane = planes.interleaved.ok_or("no interleaved RGB plane")?;
    let (w, h) = (plane.width, plane.height);
    let row = w as usize * 3;
    let mut buf = Vec::with_capacity(row * h as usize);
    for y in 0..h as usize {
        buf.extend_from_slice(&plane.data[y * plane.stride..y * plane.stride + row]);
    }
    Ok(RgbImage::from_raw(w, h, buf).ok_or("bad RGB buffer")?)
}

#[cfg(not(feature = "heic"))]
fn decode_heif(_path: &str) -> Res<RgbImage> {
    Err("built without the `heic` feature".into())
}

#[cfg(feature = "heic")]
fn info() -> Res<()> {
    let lib = libheif_rs::LibHeif::new();
    let v = lib.version();
    println!("libheif {}.{}.{}", v[0], v[1], v[2]);
    let decoders = lib.decoder_descriptors(32, None);
    if decoders.is_empty() {
        println!("decoders: NONE");
    }
    for d in decoders {
        println!("decoder: {} ({})", d.id(), d.name());
    }
    Ok(())
}

#[cfg(not(feature = "heic"))]
fn info() -> Res<()> {
    println!("built without libheif");
    Ok(())
}

/// Which quadrant of the image is (on average) the reddest.
fn red_quadrant(img: &RgbImage) -> &'static str {
    let (w, h) = img.dimensions();
    let mut score = [0i64; 4];
    // Sample on a coarse grid; plenty for a 4-way decision.
    for y in (0..h).step_by(8) {
        for x in (0..w).step_by(8) {
            let p = img.get_pixel(x, y).0;
            let q = (if y >= h / 2 { 2 } else { 0 }) + (if x >= w / 2 { 1 } else { 0 });
            score[q] += p[0] as i64 * 2 - p[1] as i64 - p[2] as i64;
        }
    }
    let best = (0..4).max_by_key(|&i| score[i]).unwrap();
    ["top-left", "top-right", "bottom-left", "bottom-right"][best]
}

/// Write a synthetic 4032x3024 (12 MP) JPEG whose stored top-left quadrant is red,
/// tagged with the given EXIF orientation.
fn gen(out: &str, orientation: u16) -> Res<()> {
    let (w, h) = (4032u32, 3024u32);
    let img = RgbImage::from_fn(w, h, |x, y| {
        // Gradient + stripes + hashed noise: gives the encoder realistic work.
        let n = {
            let mut s = x.wrapping_mul(0x9E37_79B1) ^ y.wrapping_mul(0x85EB_CA77);
            s ^= s >> 15;
            s = s.wrapping_mul(0x2C1B_3C6D);
            (s >> 24) as i32 % 24 - 12
        };
        let stripe = (((x as f32 / 37.0).sin() + (y as f32 / 53.0).cos()) * 20.0) as i32;
        let (r, g, b) = if x < w / 2 && y < h / 2 {
            (210, 40, 40)
        } else {
            (40, 60 + (y * 120 / h) as i32, 90 + (x * 140 / w) as i32)
        };
        let c = |v: i32| (v + n + stripe).clamp(0, 255) as u8;
        image::Rgb([c(r), c(g), c(b)])
    });
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 92).encode_image(&img)?;
    let jpeg = with_exif_orientation(&jpeg, orientation);
    fs::write(out, &jpeg)?;
    println!("wrote {out}: {w}x{h}, EXIF orientation {orientation}, {} bytes", jpeg.len());
    Ok(())
}

/// Insert a minimal APP1/EXIF segment carrying only the Orientation tag right after SOI.
fn with_exif_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II*\0");
    tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
    tiff.extend_from_slice(&1u16.to_le_bytes()); // 1 entry
    tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
    tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes()); // count
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
    out.extend_from_slice(&jpeg[..2]); // SOI
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}
