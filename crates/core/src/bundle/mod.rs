//! Write projects as single HTML, folder, or zip. Owner: Wave 2 · E.
//!
//! Signatures here are frozen for Wave 2 (the app and the E2E suite build against them).
//! Flow: `scan` → `media::process` → [`project`] → [`estimate`] / [`write`].
//!
//! # Layouts (`docs/DATA_CONTRACT.md` §2)
//!
//! - [`Format::Html`]: one file. Thumbnails (and web-sized or original JPEG/PNG stills, when
//!   exported) are concatenated into base64 packs addressed by `#pack:` refs. Video is never
//!   packed, so `video` refs are dropped; items fall back to their thumbnail when a still cannot
//!   be packed (HEIC, TIFF, DNG originals).
//! - [`Format::Dir`] / [`Format::Zip`]: `index.html`, `data.js`, `assets/`, `thumbs/`, `media/`,
//!   `README.txt`.
//!
//! # Privacy
//!
//! `strip_exif` removes APP1 EXIF/XMP segments from JPEG originals (the orientation tag is kept
//! as a minimal EXIF block so images stay upright). Originals in other formats are copied
//! unchanged; web-sized images are re-encoded and never carry metadata.

use std::borrow::Cow;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use crate::media::{Asset, Prepared};
use crate::model::{self, Item, Project, ProjectOptions, pack_ref};
use crate::scan::ScanReport;
use crate::{Error, Progress, Result, assets};

mod escape;
mod jpeg;

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

const README: &str = "This folder is a Photo Way map.

Unzip first, then double-click index.html.

Everything runs offline in your browser. Online map layers need an internet connection;
the built-in world map works without one.

Use More > Language / 语言 to switch between English and Simplified Chinese.

这是 Photo Way 地图文件夹。

请先解压，再双击 index.html。

地图可在浏览器中离线使用。在线地图图层需要网络连接；内置世界地图无需联网。

在“更多 > 语言 / Language”中可切换英语和简体中文。
";

fn other(e: impl Into<anyhow::Error>) -> Error {
    Error::Other(e.into())
}

fn bad(msg: impl std::fmt::Display) -> Error {
    Error::Other(anyhow::anyhow!("{msg}"))
}

// ---------------------------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------------------------

fn round_to(v: f64, decimals: u8) -> f64 {
    let f = 10f64.powi(i32::from(decimals.min(15)));
    (v * f).round() / f
}

/// File-name stem reduced to ASCII letters, digits, `-` and `_` (so refs need no URL-encoding).
fn safe_stem(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let s: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    if s.is_empty() { "file".into() } else { s }
}

fn asset_ext(asset: &Asset) -> String {
    match asset {
        Asset::Bytes { ext, .. } => (*ext).to_string(),
        Asset::File(p) => p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or_else(|| "bin".into()),
    }
}

/// RFC 3339 UTC, second precision.
fn now_rfc3339() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Builds the project document. Refs use the bundle layout (`thumbs/00000.jpg`,
/// `media/00000-<safe-name>.<ext>`); [`write`] rewrites them to pack refs for [`Format::Html`].
/// Generates a fresh `id` and `createdAt`; `items[i].id == i` in `report.entries` order.
pub fn project(report: &ScanReport, prepared: &Prepared, opts: &ExportOptions) -> Project {
    let round = |v: f64| opts.coord_decimals.map_or(v, |d| round_to(v, d));
    let items = report
        .entries
        .iter()
        .zip(&prepared.rendered)
        .enumerate()
        .map(|(i, (entry, rendered))| {
            let m = &entry.meta;
            let name = entry
                .path
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let stem = safe_stem(&name);
            let full = rendered
                .full
                .as_ref()
                .map(|a| format!("media/{i:05}-{stem}.{}", asset_ext(a)));
            let video = rendered.video.as_ref().map(|a| {
                let ext = asset_ext(a);
                let r = format!("media/{i:05}-{stem}.{ext}");
                // A still and its clip with the same extension must not share a path.
                if full.as_deref() == Some(r.as_str()) {
                    format!("media/{i:05}-{stem}-motion.{ext}")
                } else {
                    r
                }
            });
            let mut flags = Vec::new();
            if m.ts.is_none() && m.time.is_none() {
                flags.push("noTime".to_string());
            }
            Item {
                id: i as u32,
                kind: m.kind,
                name,
                time: m.time.clone(),
                ts: m.ts,
                ts_source: m.ts_source,
                day: m.day.clone(),
                lat: round(m.lat),
                lon: round(m.lon),
                alt: m.alt,
                w: m.w,
                h: m.h,
                dur: m.dur,
                thumb: format!("thumbs/{i:05}.jpg"),
                full,
                video,
                flags,
            }
        })
        .collect();
    Project {
        format: model::FORMAT.into(),
        version: model::VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        title: opts.title.clone(),
        generator: format!("photoway {}", env!("CARGO_PKG_VERSION")),
        created_at: now_rfc3339(),
        options: opts.options.clone(),
        items,
    }
}

// ---------------------------------------------------------------------------------------------
// refs and sources
// ---------------------------------------------------------------------------------------------

/// Where the bytes behind a ref come from (`usize` = index into `prepared.rendered`).
#[derive(Debug, Clone, Copy)]
enum Src {
    Thumb(usize),
    Full(usize),
    Video(usize),
}

fn src_asset(prepared: &Prepared, src: Src) -> Option<&Asset> {
    match src {
        Src::Thumb(_) => None,
        Src::Full(i) => prepared.rendered.get(i)?.full.as_ref(),
        Src::Video(i) => prepared.rendered.get(i)?.video.as_ref(),
    }
}

fn is_jpeg_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
}

fn src_len(prepared: &Prepared, src: Src, strip: bool) -> io::Result<u64> {
    match (src, src_asset(prepared, src)) {
        (Src::Thumb(i), _) => Ok(prepared.rendered[i].thumb_jpeg.len() as u64),
        (_, Some(Asset::Bytes { data, .. })) => Ok(data.len() as u64),
        (_, Some(Asset::File(p))) => {
            if strip
                && is_jpeg_path(p)
                && let Some(plan) = jpeg::plan(BufReader::new(File::open(p)?))?
            {
                return Ok(plan.output_len());
            }
            Ok(std::fs::metadata(p)?.len())
        }
        (_, None) => Ok(0),
    }
}

fn src_bytes(prepared: &Prepared, src: Src, strip: bool) -> io::Result<Cow<'_, [u8]>> {
    match (src, src_asset(prepared, src)) {
        (Src::Thumb(i), _) => Ok(Cow::Borrowed(&prepared.rendered[i].thumb_jpeg)),
        (_, Some(Asset::Bytes { data, .. })) => Ok(Cow::Borrowed(data)),
        (_, Some(Asset::File(p))) => {
            let data = std::fs::read(p)?;
            if strip
                && is_jpeg_path(p)
                && let Some(stripped) = jpeg::strip(&data)
            {
                return Ok(Cow::Owned(stripped));
            }
            Ok(Cow::Owned(data))
        }
        (_, None) => Ok(Cow::Borrowed(&[])),
    }
}

/// A ref that may be used as a path inside the output: relative, `/`-separated, no `..`.
fn is_safe_rel(r: &str) -> bool {
    !r.is_empty()
        && !r.starts_with('/')
        && !r.starts_with('#')
        && !r.contains(char::from(92u8))
        && !r.contains(':')
        && r.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

/// Copy of `project` whose `thumb`/`full`/`video` refs only point at media that exists.
fn normalize(prepared: &Prepared, project: &Project) -> Result<Project> {
    if project.items.len() > prepared.rendered.len() {
        return Err(bad(format!(
            "project has {} items but only {} were rendered",
            project.items.len(),
            prepared.rendered.len()
        )));
    }
    let mut p = project.clone();
    for (i, it) in p.items.iter_mut().enumerate() {
        if src_asset(prepared, Src::Full(i)).is_none() {
            it.full = None;
        }
        if src_asset(prepared, Src::Video(i)).is_none() {
            it.video = None;
        }
    }
    Ok(p)
}

/// The asset behind a bundle-layout ref of `project`, e.g. for the app's preview protocol.
/// Returns `None` for unknown refs. Thumbnails are not [`Asset`]s: use [`thumb_for_ref`].
pub fn asset_for_ref<'a>(prepared: &'a Prepared, project: &Project, rel: &str) -> Option<&'a Asset> {
    let i = project
        .items
        .iter()
        .position(|it| it.full.as_deref() == Some(rel) || it.video.as_deref() == Some(rel))?;
    let it = &project.items[i];
    let src = if it.full.as_deref() == Some(rel) {
        Src::Full(i)
    } else {
        Src::Video(i)
    };
    src_asset(prepared, src)
}

/// The thumbnail JPEG behind a bundle-layout `thumbs/…` ref of `project`.
pub fn thumb_for_ref<'a>(prepared: &'a Prepared, project: &Project, rel: &str) -> Option<&'a [u8]> {
    let i = project.items.iter().position(|it| it.thumb == rel)?;
    prepared.rendered.get(i).map(|r| r.thumb_jpeg.as_slice())
}

// ---------------------------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Title,
    Styles,
    Data,
    Basemap,
    Scripts,
}

const SLOTS: [(Slot, &str); 5] = [
    (Slot::Title, "{{PW_TITLE}}"),
    (Slot::Styles, "<!--PW_STYLES-->"),
    (Slot::Data, "<!--PW_DATA-->"),
    (Slot::Basemap, "<!--PW_BASEMAP-->"),
    (Slot::Scripts, "<!--PW_SCRIPTS-->"),
];

enum Seg<'a> {
    Text(&'a str),
    Slot(Slot),
}

/// Splits the template at its placeholders; each must occur exactly once.
fn segments(template: &str) -> Result<Vec<Seg<'_>>> {
    let mut found = Vec::new();
    for (slot, key) in SLOTS {
        let mut at = template.match_indices(key);
        let (Some((pos, _)), None) = (at.next(), at.next()) else {
            return Err(bad(format!(
                "template placeholder {key} must appear exactly once"
            )));
        };
        found.push((pos, key.len(), slot));
    }
    found.sort_by_key(|f| f.0);
    let mut out = Vec::new();
    let mut last = 0;
    for (pos, len, slot) in found {
        out.push(Seg::Text(&template[last..pos]));
        out.push(Seg::Slot(slot));
        last = pos + len;
    }
    out.push(Seg::Text(&template[last..]));
    Ok(out)
}

fn template() -> Result<&'static str> {
    std::str::from_utf8(assets::TEMPLATE_HTML).map_err(other)
}

fn utf8(b: &'static [u8]) -> Result<&'static str> {
    std::str::from_utf8(b).map_err(other)
}

fn project_json(project: &Project) -> Result<String> {
    Ok(escape::json(&serde_json::to_string(project).map_err(other)?))
}

fn basemap_script() -> Result<String> {
    Ok(format!(
        "<script id=\"pw-basemap\" type=\"application/json\">{}</script>",
        escape::json(utf8(assets::BASEMAP_JSON)?)
    ))
}

// ---------------------------------------------------------------------------------------------
// progress and output plumbing
// ---------------------------------------------------------------------------------------------

struct Ticker<'a> {
    progress: Option<&'a dyn Progress>,
    done: u64,
    total: u64,
}

impl Ticker<'_> {
    fn tick(&mut self, label: &str) -> Result<()> {
        if let Some(p) = self.progress {
            if p.cancelled() {
                return Err(Error::Cancelled);
            }
            p.update(self.done, self.total, label);
        }
        self.done += 1;
        Ok(())
    }
}

/// Counts the bytes written through it.
struct Count<W> {
    inner: W,
    n: u64,
}

impl<W: Write> Write for Count<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let k = self.inner.write(buf)?;
        self.n += k as u64;
        Ok(k)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Streaming standard base64 without line breaks.
#[derive(Default)]
struct B64 {
    carry: Vec<u8>,
}

impl B64 {
    const CHUNK: usize = 3 * 16 * 1024;

    fn push<W: Write>(&mut self, w: &mut W, mut data: &[u8]) -> io::Result<()> {
        if !self.carry.is_empty() {
            let take = (3 - self.carry.len()).min(data.len());
            self.carry.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.carry.len() < 3 {
                return Ok(());
            }
            w.write_all(STANDARD.encode(&self.carry).as_bytes())?;
            self.carry.clear();
        }
        let whole = data.len() / 3 * 3;
        let mut buf = vec![0u8; Self::CHUNK / 3 * 4];
        for chunk in data[..whole].chunks(Self::CHUNK) {
            let n = STANDARD.encode_slice(chunk, &mut buf).map_err(io::Error::other)?;
            w.write_all(&buf[..n])?;
        }
        self.carry.extend_from_slice(&data[whole..]);
        Ok(())
    }

    fn finish<W: Write>(self, w: &mut W) -> io::Result<()> {
        if self.carry.is_empty() {
            Ok(())
        } else {
            w.write_all(STANDARD.encode(&self.carry).as_bytes())
        }
    }
}

/// Runs `fill` against a temp file next to `out`, then renames it into place.
fn atomic_file<T>(out: &Path, fill: impl FnOnce(File) -> Result<T>) -> Result<T> {
    if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp_name = out
        .file_name()
        .map_or_else(Default::default, |n| n.to_os_string());
    tmp_name.push(".photoway-part");
    let tmp = out.with_file_name(tmp_name);
    let result = File::create(&tmp)
        .map_err(Error::from)
        .and_then(fill)
        .and_then(|v| std::fs::rename(&tmp, out).map(|()| v).map_err(Error::from));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// ---------------------------------------------------------------------------------------------
// single HTML
// ---------------------------------------------------------------------------------------------

fn packable(asset: &Asset) -> bool {
    matches!(asset_ext(asset).as_str(), "jpg" | "jpeg" | "png")
}

/// The project as embedded in a single HTML file, plus the item indexes whose `full` is packed.
fn html_project(prepared: &Prepared, project: &Project, strip: bool) -> Result<(Project, Vec<usize>)> {
    let mut p = normalize(prepared, project)?;
    let (mut thumb_off, mut full_off) = (0u64, 0u64);
    let mut fulls = Vec::new();
    for (i, it) in p.items.iter_mut().enumerate() {
        let len = src_len(prepared, Src::Thumb(i), strip)?;
        it.thumb = pack_ref("thumbs", thumb_off, len);
        thumb_off += len;
        it.video = None;
        match src_asset(prepared, Src::Full(i)) {
            Some(a) if it.full.is_some() && packable(a) => {
                let len = src_len(prepared, Src::Full(i), strip)?;
                it.full = Some(pack_ref("full", full_off, len));
                full_off += len;
                fulls.push(i);
            }
            _ => it.full = None,
        }
    }
    Ok((p, fulls))
}

fn write_pack<W: Write>(
    w: &mut Count<W>,
    prepared: &Prepared,
    srcs: &[Src],
    strip: bool,
    dry: bool,
    ticker: &mut Ticker<'_>,
) -> Result<()> {
    if dry {
        let mut total = 0u64;
        for &s in srcs {
            total += src_len(prepared, s, strip)?;
        }
        w.n += total.div_ceil(3) * 4;
        return Ok(());
    }
    let mut enc = B64::default();
    for &s in srcs {
        ticker.tick("pack")?;
        enc.push(w, &src_bytes(prepared, s, strip)?)?;
    }
    enc.finish(w)?;
    Ok(())
}

/// Writes the whole page. With `dry`, packs are only counted, not read.
fn write_html<W: Write>(
    w: &mut Count<W>,
    prepared: &Prepared,
    project: &Project,
    strip: bool,
    dry: bool,
    ticker: &mut Ticker<'_>,
) -> Result<()> {
    let (hp, fulls) = html_project(prepared, project, strip)?;
    let css = escape::code(assets::VIEWER_CSS, "style");
    let js = escape::code(assets::VIEWER_JS, "script");
    for seg in segments(template()?)? {
        match seg {
            Seg::Text(t) => w.write_all(t.as_bytes())?,
            Seg::Slot(Slot::Title) => w.write_all(escape::html(&hp.title).as_bytes())?,
            Seg::Slot(Slot::Styles) => {
                w.write_all(b"<style>")?;
                w.write_all(&css)?;
                w.write_all(b"</style>")?;
            }
            Seg::Slot(Slot::Data) => {
                writeln!(
                    w,
                    "<script id=\"pw-data\" type=\"application/json\">{}</script>",
                    project_json(&hp)?
                )?;
                let open = |id: &str| {
                    format!(
                        "<script id=\"pw-pack-{id}\" type=\"application/octet-stream\" data-encoding=\"base64\" data-mime=\"image/jpeg\">"
                    )
                };
                w.write_all(open("thumbs").as_bytes())?;
                let thumbs: Vec<Src> = (0..hp.items.len()).map(Src::Thumb).collect();
                write_pack(w, prepared, &thumbs, strip, dry, ticker)?;
                w.write_all(b"</script>\n")?;
                if !fulls.is_empty() {
                    w.write_all(open("full").as_bytes())?;
                    let srcs: Vec<Src> = fulls.iter().map(|&i| Src::Full(i)).collect();
                    write_pack(w, prepared, &srcs, strip, dry, ticker)?;
                    w.write_all(b"</script>\n")?;
                }
            }
            Seg::Slot(Slot::Basemap) => w.write_all(basemap_script()?.as_bytes())?,
            Seg::Slot(Slot::Scripts) => {
                w.write_all(b"<script>")?;
                w.write_all(&js)?;
                w.write_all(b"</script>")?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// bundle (dir / zip)
// ---------------------------------------------------------------------------------------------

/// `index.html`, `data.js`, viewer assets and the README.
fn bundle_docs(project: &Project) -> Result<Vec<(&'static str, Vec<u8>)>> {
    let mut index = Vec::new();
    for seg in segments(template()?)? {
        match seg {
            Seg::Text(t) => index.extend_from_slice(t.as_bytes()),
            Seg::Slot(Slot::Title) => index.extend_from_slice(escape::html(&project.title).as_bytes()),
            Seg::Slot(Slot::Styles) => {
                index.extend_from_slice(b"<link rel=\"stylesheet\" href=\"assets/viewer.css\">")
            }
            Seg::Slot(Slot::Data) => index.extend_from_slice(b"<script src=\"data.js\"></script>"),
            Seg::Slot(Slot::Basemap) => index.extend_from_slice(basemap_script()?.as_bytes()),
            Seg::Slot(Slot::Scripts) => {
                index.extend_from_slice(b"<script src=\"assets/viewer.js\"></script>")
            }
        }
    }
    let data = format!("window.__PHOTOWAY__ = {};\n", project_json(project)?);
    Ok(vec![
        ("index.html", index),
        ("data.js", data.into_bytes()),
        ("assets/viewer.js", assets::VIEWER_JS.to_vec()),
        ("assets/viewer.css", assets::VIEWER_CSS.to_vec()),
        ("README.txt", README.as_bytes().to_vec()),
    ])
}

/// Every media file of a bundle: path inside the output and its source.
fn bundle_media(project: &Project) -> Result<Vec<(String, Src)>> {
    let mut out = Vec::new();
    for (i, it) in project.items.iter().enumerate() {
        let refs = [
            Some((&it.thumb, Src::Thumb(i))),
            it.full.as_ref().map(|r| (r, Src::Full(i))),
            it.video.as_ref().map(|r| (r, Src::Video(i))),
        ];
        for (r, src) in refs.into_iter().flatten() {
            if !is_safe_rel(r) {
                return Err(bad(format!("unsafe path in project: {r}")));
            }
            out.push((r.clone(), src));
        }
    }
    Ok(out)
}

trait Sink {
    /// `compress`: text-like content; media is already compressed.
    fn put(&mut self, path: &str, data: &[u8], compress: bool) -> Result<()>;
}

struct DirSink {
    root: PathBuf,
    bytes: u64,
}

impl Sink for DirSink {
    fn put(&mut self, path: &str, data: &[u8], _compress: bool) -> Result<()> {
        let dest = self.root.join(path);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(dest, data)?;
        self.bytes += data.len() as u64;
        Ok(())
    }
}

struct ZipSink<W: Write + io::Seek> {
    zip: zip::ZipWriter<W>,
}

impl<W: Write + io::Seek> Sink for ZipSink<W> {
    fn put(&mut self, path: &str, data: &[u8], compress: bool) -> Result<()> {
        let method = if compress {
            zip::CompressionMethod::Deflated
        } else {
            zip::CompressionMethod::Stored
        };
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(method)
            .large_file(data.len() as u64 >= u64::from(u32::MAX) - 1024);
        self.zip.start_file(path, opts).map_err(other)?;
        self.zip.write_all(data)?;
        Ok(())
    }
}

fn write_bundle(
    sink: &mut dyn Sink,
    prepared: &Prepared,
    project: &Project,
    strip: bool,
    progress: &dyn Progress,
) -> Result<()> {
    let media = bundle_media(project)?;
    let mut ticker = Ticker {
        progress: Some(progress),
        done: 0,
        total: media.len() as u64,
    };
    for (path, data) in bundle_docs(project)? {
        sink.put(path, &data, true)?;
    }
    for (path, src) in media {
        ticker.tick(&path)?;
        sink.put(&path, &src_bytes(prepared, src, strip)?, false)?;
    }
    progress.update(ticker.total, ticker.total, "done");
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// write / estimate
// ---------------------------------------------------------------------------------------------

/// Estimated output size in bytes, without writing anything. HTML and folder sizes are exact
/// apart from EXIF stripping; zip sizes assume stored media and deflated text.
pub fn estimate(prepared: &Prepared, project: &Project, format: Format, opts: &ExportOptions) -> u64 {
    let strip = opts.strip_exif;
    let Ok(project) = normalize(prepared, project) else {
        return 0;
    };
    match format {
        Format::Html => {
            let mut w = Count {
                inner: io::sink(),
                n: 0,
            };
            let mut ticker = Ticker {
                progress: None,
                done: 0,
                total: 0,
            };
            let _ = write_html(&mut w, prepared, &project, strip, true, &mut ticker);
            w.n
        }
        Format::Dir | Format::Zip => {
            let Ok(docs) = bundle_docs(&project) else {
                return 0;
            };
            let Ok(media) = bundle_media(&project) else {
                return 0;
            };
            let media_len = |(path, src): &(String, Src)| {
                let len = src_len(prepared, *src, strip).unwrap_or(0);
                if format == Format::Zip {
                    // Local header + central directory entry.
                    len + 76 + 2 * path.len() as u64
                } else {
                    len
                }
            };
            let media_total: u64 = media.iter().map(media_len).sum();
            if format == Format::Dir {
                return media_total + docs.iter().map(|(_, d)| d.len() as u64).sum::<u64>();
            }
            let mut sink = ZipSink {
                zip: zip::ZipWriter::new(Cursor::new(Vec::new())),
            };
            for (path, data) in &docs {
                if sink.put(path, data, true).is_err() {
                    return 0;
                }
            }
            let text = sink.zip.finish().map_or(0, |c| c.into_inner().len() as u64);
            text + media_total
        }
    }
}

/// Writes `project` to `out` (an `.html` file, a directory, or a `.zip` file).
/// Single files are written to a temporary neighbour and renamed into place.
pub fn write(
    prepared: &Prepared,
    project: &Project,
    format: Format,
    out: &Path,
    opts: &ExportOptions,
    progress: &dyn Progress,
) -> Result<WriteReport> {
    if progress.cancelled() {
        return Err(Error::Cancelled);
    }
    let strip = opts.strip_exif;
    let project = normalize(prepared, project)?;
    let bytes = match format {
        Format::Html => {
            let (_, fulls) = html_project(prepared, &project, strip)?;
            let total = (project.items.len() + fulls.len()) as u64;
            atomic_file(out, |file| {
                let mut w = Count {
                    inner: BufWriter::with_capacity(1 << 20, file),
                    n: 0,
                };
                let mut ticker = Ticker {
                    progress: Some(progress),
                    done: 0,
                    total,
                };
                write_html(&mut w, prepared, &project, strip, false, &mut ticker)?;
                w.flush()?;
                progress.update(total, total, "done");
                Ok(w.n)
            })?
        }
        Format::Zip => atomic_file(out, |file| {
            let mut sink = ZipSink {
                zip: zip::ZipWriter::new(BufWriter::with_capacity(1 << 20, file)),
            };
            write_bundle(&mut sink, prepared, &project, strip, progress)?;
            let mut inner = sink.zip.finish().map_err(other)?;
            inner.flush()?;
            Ok(inner.get_ref().metadata()?.len())
        })?,
        Format::Dir => {
            if out.is_file() {
                return Err(bad(format!("{} is a file, not a folder", out.display())));
            }
            std::fs::create_dir_all(out)?;
            let mut sink = DirSink {
                root: out.to_path_buf(),
                bytes: 0,
            };
            write_bundle(&mut sink, prepared, &project, strip, progress)?;
            sink.bytes
        }
    };
    Ok(WriteReport {
        path: out.to_path_buf(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_template_has_each_placeholder_once() {
        let segs = segments(template().unwrap()).unwrap();
        assert_eq!(segs.iter().filter(|s| matches!(s, Seg::Slot(_))).count(), 5);
    }

    #[test]
    fn missing_or_repeated_placeholders_are_errors() {
        let all: String = SLOTS.iter().map(|(_, k)| *k).collect();
        assert!(segments(&all).is_ok());
        assert!(segments(&format!("{all}{{{{PW_TITLE}}}}")).is_err());
        assert!(segments(&all.replace("<!--PW_DATA-->", "")).is_err());
    }

    #[test]
    fn refs_must_stay_inside_the_output() {
        assert!(is_safe_rel("media/00001-IMG_0001.jpg"));
        for bad in ["", "/a", "../a", "a/../b", "a//b", "#pack:thumbs:0:1", "c:/a"] {
            assert!(!is_safe_rel(bad), "{bad}");
        }
        assert!(!is_safe_rel(&format!("a{}b", char::from(92u8))));
    }

    #[test]
    fn base64_streaming_matches_one_shot_for_any_split() {
        let data: Vec<u8> = (0..200u32).map(|i| (i * 7) as u8).collect();
        for cut in 0..data.len() {
            let mut out = Vec::new();
            let mut enc = B64::default();
            enc.push(&mut out, &data[..cut]).unwrap();
            enc.push(&mut out, &data[cut..]).unwrap();
            enc.finish(&mut out).unwrap();
            assert_eq!(out, STANDARD.encode(&data).into_bytes(), "cut {cut}");
        }
    }
}
