//! Tests for `photoway_core::media`. Images are generated in code; the HEIC fixture is
//! `tests/data/sample-o6.heic` (640x480 stored, `irot` 90 degrees, top-left quadrant red).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use image::{Rgb, RgbImage};
use photoway_core::media::{
    Asset, Decoder, DngDecoder, FullSize, ImageDecoder, MediaOptions, Prepared, THUMB_SIZE, has_poster,
    process, set_poster,
};
use photoway_core::meta::Meta;
use photoway_core::model::Kind;
use photoway_core::scan::{Entry, ScanReport};
use photoway_core::{Error, NoProgress, Progress};

const RED: Rgb<u8> = Rgb([210, 40, 40]);

fn meta(kind: Kind) -> Meta {
    Meta {
        kind,
        lat: 1.0,
        lon: 2.0,
        alt: None,
        time: None,
        ts: None,
        ts_source: None,
        day: None,
        w: 0,
        h: 0,
        orientation: 1,
        dur: None,
    }
}

fn entry(path: &Path, kind: Kind) -> Entry {
    Entry {
        path: path.to_path_buf(),
        motion: None,
        meta: meta(kind),
    }
}

fn report(entries: Vec<Entry>) -> ScanReport {
    ScanReport {
        entries,
        skipped: vec![],
    }
}

/// Stored image whose top-left quadrant is red and the rest blue-ish.
fn quadrant_image(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        if x < w / 2 && y < h / 2 {
            RED
        } else {
            Rgb([40, 60, 160])
        }
    })
}

fn jpeg_bytes(img: &RgbImage) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
        .encode_image(img)
        .unwrap();
    out
}

/// Insert an APP1/EXIF segment carrying only the Orientation tag right after SOI.
fn with_exif_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II*\0");
    tiff.extend_from_slice(&8u32.to_le_bytes());
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x0112u16.to_le_bytes());
    tiff.extend_from_slice(&3u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_le_bytes());
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn write(dir: &Path, name: &str, data: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, data).unwrap();
    p
}

/// Quadrant (0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right) that is reddest.
fn red_quadrant(img: &RgbImage) -> usize {
    let (w, h) = img.dimensions();
    let mut score = [0i64; 4];
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x, y).0;
            let q = usize::from(y >= h / 2) * 2 + usize::from(x >= w / 2);
            score[q] += i64::from(p[0]) * 2 - i64::from(p[1]) - i64::from(p[2]);
        }
    }
    (0..4).max_by_key(|&i| score[i]).unwrap()
}

fn decode_jpeg(data: &[u8]) -> RgbImage {
    image::load_from_memory_with_format(data, image::ImageFormat::Jpeg)
        .unwrap()
        .into_rgb8()
}

fn run(entries: Vec<Entry>, opts: &MediaOptions) -> Prepared {
    process(&report(entries), opts, &NoProgress).unwrap()
}

fn full_bytes(p: &Prepared, i: usize) -> &[u8] {
    match p.rendered[i].full.as_ref().expect("full asset") {
        Asset::Bytes { data, .. } => data,
        Asset::File(_) => panic!("expected bytes"),
    }
}

#[test]
fn all_eight_exif_orientations() {
    let dir = tempfile::tempdir().unwrap();
    let stored = jpeg_bytes(&quadrant_image(200, 120));
    // (orientation, expected red quadrant, dims swapped)
    let cases = [
        (1u16, 0usize, false),
        (2, 1, false),
        (3, 3, false),
        (4, 2, false),
        (5, 0, true),
        (6, 1, true),
        (7, 3, true),
        (8, 2, true),
    ];
    for (o, quad, swapped) in cases {
        let path = write(
            dir.path(),
            &format!("o{o}.jpg"),
            &with_exif_orientation(&stored, o),
        );
        let img = ImageDecoder.decode(&path).unwrap();
        let dims = if swapped { (120, 200) } else { (200, 120) };
        assert_eq!(img.dimensions(), dims, "orientation {o}");
        assert_eq!(red_quadrant(&img), quad, "orientation {o}");
    }
}

#[test]
fn thumbnail_is_oriented_center_crop_square() {
    let dir = tempfile::tempdir().unwrap();
    // 600x300 stored, orientation 6 -> displayed 300x600 (portrait). Vertical bands in the
    // stored image become horizontal bands: stored left third (blue) ends up on top.
    let img = RgbImage::from_fn(600, 300, |x, _| match x / 200 {
        0 => Rgb([20, 20, 220]),
        1 => Rgb([20, 220, 20]),
        _ => Rgb([220, 20, 20]),
    });
    let path = write(dir.path(), "p.jpg", &with_exif_orientation(&jpeg_bytes(&img), 6));
    let opts = MediaOptions {
        full: FullSize::None,
        ..Default::default()
    };
    let out = run(vec![entry(&path, Kind::Photo)], &opts);
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    let thumb = decode_jpeg(&out.rendered[0].thumb_jpeg);
    assert_eq!(thumb.dimensions(), (THUMB_SIZE, THUMB_SIZE));
    assert!(out.rendered[0].full.is_none());
    // Displayed portrait 300x600 (bands top to bottom: blue, green, red, 200 px each) is
    // center-cropped to the middle 300x300 (y 150..450): a little blue on top, mostly
    // green, a little red at the bottom.
    for x in [5, 128, 250] {
        let top = thumb.get_pixel(x, 5).0;
        let mid = thumb.get_pixel(x, 128).0;
        let bottom = thumb.get_pixel(x, 250).0;
        assert!(top[2] > 150 && top[0] < 90, "top {top:?}");
        assert!(mid[1] > 150 && mid[0] < 90 && mid[2] < 90, "mid {mid:?}");
        assert!(bottom[0] > 150 && bottom[2] < 90, "bottom {bottom:?}");
    }
}

#[test]
fn web_preview_long_edge_never_upscales_and_has_no_exif() {
    let dir = tempfile::tempdir().unwrap();
    let big = write(
        dir.path(),
        "big.jpg",
        &with_exif_orientation(&jpeg_bytes(&quadrant_image(3000, 2000)), 1),
    );
    let small = write(dir.path(), "small.jpg", &jpeg_bytes(&quadrant_image(800, 600)));
    let entries = vec![entry(&big, Kind::Photo), entry(&small, Kind::Photo)];

    let out = run(entries.clone(), &MediaOptions::default());
    assert_eq!(decode_jpeg(full_bytes(&out, 0)).dimensions(), (2048, 1365));
    assert_eq!(decode_jpeg(full_bytes(&out, 1)).dimensions(), (800, 600));

    // The requested edge is clamped to 1280..=4096.
    let low = run(
        entries.clone(),
        &MediaOptions {
            web_long_edge: 100,
            ..Default::default()
        },
    );
    assert_eq!(decode_jpeg(full_bytes(&low, 0)).dimensions(), (1280, 853));
    let high = run(
        entries,
        &MediaOptions {
            web_long_edge: 99999,
            ..Default::default()
        },
    );
    assert_eq!(decode_jpeg(full_bytes(&high, 0)).dimensions(), (3000, 2000));

    for p in [&out, &low, &high] {
        for i in 0..2 {
            let bytes = full_bytes(p, i);
            assert!(!bytes.windows(4).any(|w| w == b"Exif"), "EXIF leaked");
            assert!(
                !bytes.windows(2).any(|w| w == [0xFF, 0xE1]),
                "APP1 marker present"
            );
        }
    }
}

#[test]
fn web_preview_is_oriented() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        "o6.jpg",
        &with_exif_orientation(&jpeg_bytes(&quadrant_image(400, 240)), 6),
    );
    let out = run(vec![entry(&path, Kind::Photo)], &MediaOptions::default());
    let img = decode_jpeg(full_bytes(&out, 0));
    assert_eq!(img.dimensions(), (240, 400));
    assert_eq!(red_quadrant(&img), 1);
}

#[test]
fn original_and_none_modes() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "a.jpg", &jpeg_bytes(&quadrant_image(300, 200)));
    let orig = run(
        vec![entry(&path, Kind::Photo)],
        &MediaOptions {
            full: FullSize::Original,
            ..Default::default()
        },
    );
    assert!(matches!(&orig.rendered[0].full, Some(Asset::File(p)) if p == &path));
    let none = run(
        vec![entry(&path, Kind::Photo)],
        &MediaOptions {
            full: FullSize::None,
            ..Default::default()
        },
    );
    assert!(none.rendered[0].full.is_none());
}

#[test]
fn cache_hit_skips_decoding_and_recovers_from_corruption() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let a = write(dir.path(), "a.jpg", &jpeg_bytes(&quadrant_image(900, 600)));
    let b = write(dir.path(), "b.png", &{
        let mut v = Vec::new();
        quadrant_image(500, 500)
            .write_to(&mut std::io::Cursor::new(&mut v), image::ImageFormat::Png)
            .unwrap();
        v
    });
    let entries = vec![entry(&a, Kind::Photo), entry(&b, Kind::Photo)];
    let opts = MediaOptions {
        cache_dir: Some(cache.clone()),
        ..Default::default()
    };

    let first = run(entries.clone(), &opts);
    assert_eq!(first.stats.decoded, 2);
    assert_eq!(first.stats.cache_hits, 0);

    let second = run(entries.clone(), &opts);
    assert_eq!(second.stats.decoded, 0, "second run must not decode");
    assert_eq!(second.stats.cache_hits, 2);
    for i in 0..2 {
        assert_eq!(first.rendered[i].thumb_jpeg, second.rendered[i].thumb_jpeg);
        assert_eq!(full_bytes(&first, i), full_bytes(&second, i));
    }

    // A different render parameter is a different cache entry.
    let other = run(
        entries.clone(),
        &MediaOptions {
            web_long_edge: 1500,
            ..opts.clone()
        },
    );
    assert_eq!(other.stats.decoded, 2);

    // Corrupt / truncated entries are ignored and rewritten.
    let mut cached = Vec::new();
    for sub in std::fs::read_dir(&cache).unwrap() {
        for f in std::fs::read_dir(sub.unwrap().path()).unwrap() {
            cached.push(f.unwrap().path());
        }
    }
    assert!(cached.len() >= 6, "{cached:?}");
    for (i, f) in cached.iter().enumerate() {
        if i % 2 == 0 {
            std::fs::write(f, b"garbage").unwrap();
        } else {
            let d = std::fs::read(f).unwrap();
            std::fs::write(f, &d[..d.len() / 2]).unwrap();
        }
    }
    let third = run(entries.clone(), &opts);
    assert!(third.errors.is_empty());
    assert_eq!(third.rendered[0].thumb_jpeg, first.rendered[0].thumb_jpeg);
    let fourth = run(entries, &opts);
    assert_eq!(fourth.stats.cache_hits, 2, "cache repaired");
}

struct CancelAfter {
    seen: AtomicU64,
    limit: u64,
    flag: AtomicBool,
}

impl Progress for CancelAfter {
    fn update(&self, done: u64, _: u64, _: &str) {
        self.seen.store(done, Ordering::SeqCst);
        if done >= self.limit {
            self.flag.store(true, Ordering::SeqCst);
        }
    }
    fn cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

#[test]
fn cancellation_returns_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "a.jpg", &jpeg_bytes(&quadrant_image(300, 200)));
    let entries: Vec<Entry> = (0..200).map(|_| entry(&path, Kind::Photo)).collect();

    let progress = CancelAfter {
        seen: AtomicU64::new(0),
        limit: 3,
        flag: AtomicBool::new(false),
    };
    let err = process(&report(entries.clone()), &MediaOptions::default(), &progress).unwrap_err();
    assert!(matches!(err, Error::Cancelled));
    assert!(progress.seen.load(Ordering::SeqCst) < 200);

    let before = CancelAfter {
        seen: AtomicU64::new(0),
        limit: 0,
        flag: AtomicBool::new(true),
    };
    let err = process(&report(entries), &MediaOptions::default(), &before).unwrap_err();
    assert!(matches!(err, Error::Cancelled));
}

#[test]
fn progress_reports_every_item() {
    struct Count(AtomicU64);
    impl Progress for Count {
        fn update(&self, _: u64, total: u64, _: &str) {
            assert_eq!(total, 3);
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "a.jpg", &jpeg_bytes(&quadrant_image(300, 200)));
    let entries = (0..3).map(|_| entry(&path, Kind::Photo)).collect();
    let c = Count(AtomicU64::new(0));
    process(&report(entries), &MediaOptions::default(), &c).unwrap();
    assert_eq!(c.0.load(Ordering::SeqCst), 3);
}

#[test]
fn bad_file_does_not_abort_the_batch() {
    let dir = tempfile::tempdir().unwrap();
    let good = write(dir.path(), "good.jpg", &jpeg_bytes(&quadrant_image(300, 200)));
    let bad = write(dir.path(), "bad.jpg", b"definitely not a jpeg");
    let missing = dir.path().join("missing.png");
    let weird = write(dir.path(), "notes.xyz", b"?");
    let out = run(
        vec![
            entry(&good, Kind::Photo),
            entry(&bad, Kind::Photo),
            entry(&missing, Kind::Photo),
            entry(&weird, Kind::Photo),
        ],
        &MediaOptions::default(),
    );
    assert_eq!(out.rendered.len(), 4);
    assert_eq!(out.stats.failed, 3);
    let idx: Vec<usize> = out.errors.iter().map(|e| e.index).collect();
    assert_eq!(idx.len(), 3);
    for i in [1, 2, 3] {
        assert!(idx.contains(&i));
        assert!(out.rendered[i].full.is_none());
        assert_eq!(
            decode_jpeg(&out.rendered[i].thumb_jpeg).dimensions(),
            (THUMB_SIZE, THUMB_SIZE)
        );
    }
    assert!(out.errors.iter().all(|e| !e.message.is_empty()));
    assert!(out.rendered[0].full.is_some());
}

#[test]
fn video_placeholder_poster_and_motion() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let clip = write(dir.path(), "clip.mov", b"not really a movie");
    let still = write(dir.path(), "live.jpg", &jpeg_bytes(&quadrant_image(300, 200)));
    let motion = write(dir.path(), "live.mov", b"motion");
    let mut live = entry(&still, Kind::Live);
    live.motion = Some(motion.clone());

    let opts = MediaOptions {
        cache_dir: Some(cache.clone()),
        ..Default::default()
    };
    let entries = vec![entry(&clip, Kind::Video), live];

    let before = run(entries.clone(), &opts);
    assert!(before.errors.is_empty());
    let placeholder = decode_jpeg(&before.rendered[0].thumb_jpeg);
    assert_eq!(placeholder.dimensions(), (THUMB_SIZE, THUMB_SIZE));
    assert!(before.rendered[0].full.is_none());
    assert!(matches!(&before.rendered[0].video, Some(Asset::File(p)) if p == &clip));
    assert!(matches!(&before.rendered[1].video, Some(Asset::File(p)) if p == &motion));
    assert!(before.rendered[1].full.is_some());

    assert!(!has_poster(&cache, &clip));
    // 320x180 frame, red everywhere on the left half.
    let mut png = Vec::new();
    quadrant_image(320, 180)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    set_poster(&cache, &clip, &png).unwrap();
    assert!(has_poster(&cache, &clip));
    assert!(set_poster(&cache, &clip, b"junk").is_err());

    let after = run(entries.clone(), &opts);
    let poster = decode_jpeg(&after.rendered[0].thumb_jpeg);
    assert_eq!(poster.dimensions(), (THUMB_SIZE, THUMB_SIZE));
    assert_ne!(after.rendered[0].thumb_jpeg, before.rendered[0].thumb_jpeg);
    // 320x180 center-cropped to 180x180 (x 70..250): red top-left quadrant of the frame is
    // only partly inside; the top-left of the thumbnail is still red.
    assert_eq!(red_quadrant(&poster), 0);

    // include_video = false drops the video assets but keeps the thumbnails.
    let no_video = run(
        entries,
        &MediaOptions {
            include_video: false,
            ..opts
        },
    );
    assert!(no_video.rendered.iter().all(|r| r.video.is_none()));
}

fn synthetic_dng(preview: &[u8], ifd0_orientation: u16) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(b"II*\0");
    d.extend_from_slice(&8u32.to_le_bytes());
    let entry = |d: &mut Vec<u8>, tag: u16, typ: u16, val: u32| {
        d.extend_from_slice(&tag.to_le_bytes());
        d.extend_from_slice(&typ.to_le_bytes());
        d.extend_from_slice(&1u32.to_le_bytes());
        d.extend_from_slice(&val.to_le_bytes());
    };
    // IFD0 at 8: Orientation, SubIFDs -> 38.
    d.extend_from_slice(&2u16.to_le_bytes());
    entry(&mut d, 0x0112, 3, u32::from(ifd0_orientation));
    entry(&mut d, 0x014A, 4, 38);
    d.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(d.len(), 38);
    // SubIFD at 38: Compression 7, StripOffsets -> 80, StripByteCounts.
    d.extend_from_slice(&3u16.to_le_bytes());
    entry(&mut d, 0x0103, 3, 7);
    entry(&mut d, 0x0111, 4, 80);
    entry(&mut d, 0x0117, 4, preview.len() as u32);
    d.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(d.len(), 80);
    d.extend_from_slice(preview);
    d
}

#[test]
fn dng_uses_embedded_preview() {
    let dir = tempfile::tempdir().unwrap();
    let preview = jpeg_bytes(&quadrant_image(160, 100));
    let path = write(dir.path(), "r.dng", &synthetic_dng(&preview, 6));
    let img = DngDecoder.decode(&path).unwrap();
    assert_eq!(img.dimensions(), (100, 160));
    assert_eq!(red_quadrant(&img), 1);

    let out = run(vec![entry(&path, Kind::Photo)], &MediaOptions::default());
    assert!(out.errors.is_empty(), "{:?}", out.errors);

    let bare = write(dir.path(), "bare.dng", b"II*\0\x08\0\0\0\0\0\0\0\0\0");
    let err = DngDecoder.decode(&bare).unwrap_err().to_string();
    assert!(err.contains("preview"), "{err}");
}

#[cfg(feature = "heic")]
mod heic {
    use super::*;
    use photoway_core::media::HeifDecoder;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/sample-o6.heic")
    }

    #[test]
    fn irot_is_applied_exactly_once() {
        // Stored 640x480 with irot 90: displayed 480x640, red top-left stored quadrant -> top-right.
        let img = HeifDecoder::default().decode(&fixture()).unwrap();
        assert_eq!(img.dimensions(), (480, 640));
        assert_eq!(red_quadrant(&img), 1);
    }

    #[test]
    fn heic_thumbnail_and_web() {
        let opts = MediaOptions::default();
        let out = run(vec![entry(&fixture(), Kind::Photo)], &opts);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let thumb = decode_jpeg(&out.rendered[0].thumb_jpeg);
        assert_eq!(thumb.dimensions(), (THUMB_SIZE, THUMB_SIZE));
        assert_eq!(red_quadrant(&thumb), 1);
        let web = decode_jpeg(full_bytes(&out, 0));
        assert_eq!(web.dimensions(), (480, 640));
        assert_eq!(red_quadrant(&web), 1);
    }
}
