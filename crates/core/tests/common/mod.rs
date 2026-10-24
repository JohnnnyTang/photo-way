//! Hermetic synthetic media: JPEGs with a hand-built EXIF block and minimal MOV/MP4 files.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "photoway-test-{}-{}-{}",
            std::process::id(),
            tag,
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, rel: &str) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Copy)]
pub struct Gps {
    pub lat: f64,
    pub lon: f64,
    pub alt: Option<f64>,
    /// `YYYY:MM:DD` (UTC).
    pub date: Option<&'static str>,
    /// UTC h, m, s.
    pub time: Option<(u32, u32, u32)>,
}

impl Gps {
    pub fn at(lat: f64, lon: f64) -> Self {
        Self {
            lat,
            lon,
            alt: None,
            date: None,
            time: None,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Shot {
    pub w: u32,
    pub h: u32,
    pub orientation: Option<u16>,
    /// `YYYY:MM:DD HH:MM:SS`
    pub local: Option<&'static str>,
    /// `+08:00`
    pub offset: Option<&'static str>,
    pub gps: Option<Gps>,
    pub live_id: Option<&'static str>,
}

impl Shot {
    pub fn new(w: u32, h: u32) -> Self {
        Self {
            w,
            h,
            orientation: None,
            local: None,
            offset: None,
            gps: None,
            live_id: None,
        }
    }
}

struct Entry {
    tag: u16,
    typ: u16,
    count: u32,
    data: Vec<u8>,
}

fn ascii(tag: u16, s: &str) -> Entry {
    let mut data = s.as_bytes().to_vec();
    data.push(0);
    Entry {
        tag,
        typ: 2,
        count: data.len() as u32,
        data,
    }
}

fn short(tag: u16, v: u16) -> Entry {
    Entry {
        tag,
        typ: 3,
        count: 1,
        data: v.to_le_bytes().to_vec(),
    }
}

fn long(tag: u16, v: u32) -> Entry {
    Entry {
        tag,
        typ: 4,
        count: 1,
        data: v.to_le_bytes().to_vec(),
    }
}

fn rationals(tag: u16, vals: &[(u32, u32)]) -> Entry {
    let mut data = Vec::new();
    for (n, d) in vals {
        data.extend_from_slice(&n.to_le_bytes());
        data.extend_from_slice(&d.to_le_bytes());
    }
    Entry {
        tag,
        typ: 5,
        count: vals.len() as u32,
        data,
    }
}

fn dms(v: f64) -> Vec<(u32, u32)> {
    let v = v.abs();
    let d = v.trunc();
    let m = ((v - d) * 60.0).trunc();
    let s = ((v - d) * 60.0 - m) * 60.0;
    vec![
        (d as u32, 1),
        (m as u32, 1),
        ((s * 10_000.0).round() as u32, 10_000),
    ]
}

/// Serialises one IFD placed at `base`; out-of-line values follow the entry table.
fn ifd(mut entries: Vec<Entry>, base: u32) -> Vec<u8> {
    entries.sort_by_key(|e| e.tag);
    let table = 2 + entries.len() as u32 * 12 + 4;
    let mut out = (entries.len() as u16).to_le_bytes().to_vec();
    let mut extra: Vec<u8> = Vec::new();
    for e in &entries {
        out.extend_from_slice(&e.tag.to_le_bytes());
        out.extend_from_slice(&e.typ.to_le_bytes());
        out.extend_from_slice(&e.count.to_le_bytes());
        if e.data.len() <= 4 {
            let mut inline = e.data.clone();
            inline.resize(4, 0);
            out.extend_from_slice(&inline);
        } else {
            let off = base + table + extra.len() as u32;
            out.extend_from_slice(&off.to_le_bytes());
            extra.extend_from_slice(&e.data);
            if extra.len() % 2 == 1 {
                extra.push(0);
            }
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&extra);
    out
}

fn exif_entries(shot: &Shot) -> Vec<Entry> {
    let mut e = Vec::new();
    if let Some(t) = shot.local {
        e.push(ascii(0x9003, t));
    }
    if let Some(o) = shot.offset {
        e.push(ascii(0x9011, o));
    }
    if let Some(id) = shot.live_id {
        let mut note = b"Apple iOS\0\0\x01MM\0\x01".to_vec();
        note.extend_from_slice(&0x0011u16.to_be_bytes());
        note.extend_from_slice(&2u16.to_be_bytes());
        note.extend_from_slice(&((id.len() + 1) as u32).to_be_bytes());
        note.extend_from_slice(&32u32.to_be_bytes());
        note.extend_from_slice(&0u32.to_be_bytes());
        note.extend_from_slice(id.as_bytes());
        note.push(0);
        e.push(Entry {
            tag: 0x927C,
            typ: 7,
            count: note.len() as u32,
            data: note,
        });
    }
    e.push(long(0xA002, shot.w));
    e.push(long(0xA003, shot.h));
    e
}

fn gps_entries(g: &Gps) -> Vec<Entry> {
    let mut e = vec![
        ascii(1, if g.lat >= 0.0 { "N" } else { "S" }),
        rationals(2, &dms(g.lat)),
        ascii(3, if g.lon >= 0.0 { "E" } else { "W" }),
        rationals(4, &dms(g.lon)),
    ];
    if let Some(a) = g.alt {
        e.push(Entry {
            tag: 5,
            typ: 1,
            count: 1,
            data: vec![u8::from(a < 0.0)],
        });
        e.push(rationals(6, &[((a.abs() * 100.0) as u32, 100)]));
    }
    if let Some((h, m, s)) = g.time {
        e.push(rationals(7, &[(h, 1), (m, 1), (s, 1)]));
    }
    if let Some(d) = g.date {
        e.push(ascii(0x1D, d));
    }
    e
}

pub fn exif_tiff(shot: &Shot) -> Vec<u8> {
    let ifd0 = |exif_off: u32, gps_off: u32| {
        let mut e = vec![long(0x8769, exif_off)];
        if let Some(o) = shot.orientation {
            e.push(short(0x0112, o));
        }
        if shot.gps.is_some() {
            e.push(long(0x8825, gps_off));
        }
        e
    };
    let exif_len = ifd(exif_entries(shot), 0).len() as u32;
    let ifd0_len = ifd(ifd0(0, 0), 0).len() as u32;
    let exif_off = 8 + ifd0_len;
    let gps_off = exif_off + exif_len;

    let mut tiff = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
    tiff.extend(ifd(ifd0(exif_off, gps_off), 8));
    tiff.extend(ifd(exif_entries(shot), exif_off));
    if let Some(g) = &shot.gps {
        tiff.extend(ifd(gps_entries(g), gps_off));
    }
    tiff
}

/// A JPEG whose pixels are `shade` (so distinct shades give distinct bytes) with the EXIF of `shot`.
pub fn jpeg_bytes(shot: &Shot, shade: u8) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(shot.w, shot.h, image::Rgb([shade, shade / 2, 255 - shade]));
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
        .encode_image(&img)
        .unwrap();
    let tiff = exif_tiff(shot);
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend(tiff);
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend(app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

pub fn write_jpeg(path: &Path, shot: &Shot, shade: u8) {
    std::fs::write(path, jpeg_bytes(shot, shade)).unwrap();
}

fn boxed(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    v.extend_from_slice(typ);
    v.extend_from_slice(body);
    v
}

pub struct Mov {
    /// ISO 6709 string stored in `moov/udta/©xyz`.
    pub iso6709: Option<&'static str>,
    /// UTC seconds since the Unix epoch stored in `mvhd`.
    pub created_unix: i64,
    pub w: u32,
    pub h: u32,
    pub rotated: bool,
    pub millis: u32,
    pub live_id: Option<&'static str>,
}

pub fn mov_bytes(m: &Mov) -> Vec<u8> {
    let mut mvhd = vec![0u8; 4];
    mvhd.extend_from_slice(&((m.created_unix + 2_082_844_800) as u32).to_be_bytes());
    mvhd.extend_from_slice(&[0; 4]);
    mvhd.extend_from_slice(&1000u32.to_be_bytes());
    mvhd.extend_from_slice(&m.millis.to_be_bytes());
    mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    mvhd.extend_from_slice(&0x0100u16.to_be_bytes());
    mvhd.extend_from_slice(&[0; 10]);
    for v in [0x10000i32, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000] {
        mvhd.extend_from_slice(&v.to_be_bytes());
    }
    mvhd.extend_from_slice(&[0; 24]);
    mvhd.extend_from_slice(&2u32.to_be_bytes());

    let mut tkhd = vec![0, 0, 0, 7];
    tkhd.extend_from_slice(&[0; 8]);
    tkhd.extend_from_slice(&1u32.to_be_bytes());
    tkhd.extend_from_slice(&[0; 4]);
    tkhd.extend_from_slice(&m.millis.to_be_bytes());
    tkhd.extend_from_slice(&[0; 8 + 8]);
    let matrix: [i32; 9] = if m.rotated {
        [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x4000_0000]
    } else {
        [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000]
    };
    for v in matrix {
        tkhd.extend_from_slice(&v.to_be_bytes());
    }
    tkhd.extend_from_slice(&(m.w << 16).to_be_bytes());
    tkhd.extend_from_slice(&(m.h << 16).to_be_bytes());

    let mut moov = boxed(b"mvhd", &mvhd);
    moov.extend(boxed(b"trak", &boxed(b"tkhd", &tkhd)));
    if let Some(iso) = m.iso6709 {
        let mut xyz = (iso.len() as u16).to_be_bytes().to_vec();
        xyz.extend_from_slice(&[0x55, 0xC4]);
        xyz.extend_from_slice(iso.as_bytes());
        moov.extend(boxed(b"udta", &boxed(b"\xA9xyz", &xyz)));
    }
    if let Some(id) = m.live_id {
        let key = b"com.apple.quicktime.content.identifier";
        let mut keys = vec![0; 4];
        keys.extend_from_slice(&1u32.to_be_bytes());
        keys.extend(boxed(b"mdta", key));
        let mut value = 1u32.to_be_bytes().to_vec();
        value.extend_from_slice(&0u32.to_be_bytes());
        value.extend_from_slice(id.as_bytes());
        let ilst = boxed(&1u32.to_be_bytes(), &boxed(b"data", &value));
        let mut meta = boxed(b"keys", &keys);
        meta.extend(boxed(b"ilst", &ilst));
        moov.extend(boxed(b"meta", &meta));
    }
    let mut ftyp = b"qt  ".to_vec();
    ftyp.extend_from_slice(&[0; 4]);
    ftyp.extend_from_slice(b"qt  ");
    let mut out = boxed(b"ftyp", &ftyp);
    out.extend(boxed(b"moov", &moov));
    out.extend(boxed(b"mdat", &[0; 8]));
    out
}

pub fn write_mov(path: &Path, m: &Mov) {
    std::fs::write(path, mov_bytes(m)).unwrap();
}
