//! Tests for `photoway_core::bundle`: project building, escaping, packs, Dir/Zip layouts, estimates.

mod common;
mod export_support;

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use export_support::{Fixture, fixture};
use photoway_core::bundle::{self, ExportOptions, Format};
use photoway_core::media::{Asset, FullSize};
use photoway_core::model::{Kind, Project};
use photoway_core::{Error, NoProgress, Progress};

fn text(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).unwrap()
}

/// Text of the `<script id="...">` element.
fn script_body<'a>(html: &'a str, id: &str) -> Option<&'a str> {
    let marker = format!("id=\"{id}\"");
    let at = html.find(&marker)?;
    let start = at + html[at..].find('>')? + 1;
    let end = start + html[start..].find("</script>")?;
    Some(&html[start..end])
}

fn parse_pack_ref(r: &str) -> (String, usize, usize) {
    let parts: Vec<&str> = r.split(':').collect();
    assert_eq!(parts[0], "#pack", "{r}");
    (
        parts[1].to_string(),
        parts[2].parse().unwrap(),
        parts[3].parse().unwrap(),
    )
}

/// Decodes only the base64 characters covering `[off, off+len)`, like the viewer.
fn read_pack(b64: &str, off: usize, len: usize) -> Vec<u8> {
    let start = off / 3 * 4;
    let end = ((off + len).div_ceil(3) * 4).min(b64.len());
    let bytes = STANDARD.decode(&b64[start..end]).unwrap();
    let skip = off - off / 3 * 3;
    bytes[skip..skip + len].to_vec()
}

fn write_html(f: &Fixture, project: &Project, opts: &ExportOptions) -> String {
    let out = f.dir.path().join("out/page.html");
    let rep = bundle::write(&f.prepared, project, Format::Html, &out, opts, &NoProgress).unwrap();
    let data = std::fs::read(&out).unwrap();
    assert_eq!(rep.bytes, data.len() as u64);
    String::from_utf8(data).unwrap()
}

fn hostile_title() -> String {
    let ls = char::from_u32(0x2028).unwrap();
    let ps = char::from_u32(0x2029).unwrap();
    let apos = char::from(39u8);
    let quote = char::from(34u8);
    format!("</script><!-- & {apos}x{apos} {quote}q{quote} </STYLE> a{ls}b{ps}c")
}

#[test]
fn project_follows_the_contract() {
    let f = fixture(3, FullSize::Web);
    let opts = ExportOptions {
        coord_decimals: Some(3),
        ..f.opts.clone()
    };
    let p = bundle::project(&f.report, &f.prepared, &opts);
    assert_eq!((p.format.as_str(), p.version), ("photoway", 1));
    assert_eq!(p.items.len(), 4);
    assert_eq!(p.title, "Fixture trip");
    assert!(p.generator.starts_with("photoway "));
    assert_eq!(p.id.len(), 36);
    assert_eq!(p.id.as_bytes()[14], b'4', "uuid v4: {}", p.id);
    assert!(
        p.created_at.ends_with('Z') && p.created_at.len() == 20,
        "{}",
        p.created_at
    );
    let other = bundle::project(&f.report, &f.prepared, &opts);
    assert_ne!(p.id, other.id);
    for (i, it) in p.items.iter().enumerate() {
        assert_eq!(it.id as usize, i);
        assert_eq!(it.thumb, format!("thumbs/{i:05}.jpg"));
        let e = &f.report.entries[i].meta;
        assert_eq!(
            (it.ts, it.day.clone(), it.time.clone()),
            (e.ts, e.day.clone(), e.time.clone())
        );
        assert_eq!((it.w, it.h, it.kind), (e.w, e.h, e.kind));
        assert!(
            ((it.lat * 1000.0).round() - it.lat * 1000.0).abs() < 1e-6,
            "{}",
            it.lat
        );
    }
    let photo = p.items.iter().find(|i| i.kind == Kind::Photo).unwrap();
    let rel = photo.full.as_deref().unwrap();
    assert!(
        rel.starts_with(&format!("media/{:05}-IMG_", photo.id)) && rel.ends_with(".jpg"),
        "{rel}"
    );
    let video = p.items.iter().find(|i| i.kind == Kind::Video).unwrap();
    assert!(video.video.as_deref().unwrap().ends_with("CLIP_0001.mov"));
    assert!(video.full.is_none());
}

#[test]
fn full_none_leaves_no_media_refs() {
    let f = fixture(2, FullSize::None);
    assert!(f.project.items.iter().all(|i| i.full.is_none()));
}

#[test]
fn html_escapes_hostile_text_and_fills_every_placeholder_once() {
    let f = fixture(2, FullSize::Web);
    let mut project = f.project.clone();
    project.title = hostile_title();
    project.items[0].name = hostile_title();
    let html = write_html(&f, &project, &f.opts);

    assert!(!html.contains("{{PW_") && !html.contains("<!--PW_"));
    // Every script element is opened and closed exactly once: nothing inside can end it early.
    let lower = html.to_ascii_lowercase();
    assert_eq!(
        lower.matches("<script").count(),
        lower.matches("</script").count()
    );
    assert_eq!(lower.matches("<style").count(), 1);
    assert_eq!(lower.matches("</style").count(), 1);

    let title_start = html.find("<title>").unwrap() + 7;
    let title = &html[title_start..title_start + html[title_start..].find("</title>").unwrap()];
    assert!(!title.contains('<') && !title.contains('>') && !title.contains(char::from(34u8)));
    assert!(title.contains("&lt;/scr") && title.contains("&amp;") && title.contains("&#39;x&#39;"));

    let data = script_body(&html, "pw-data").unwrap();
    assert!(!data.contains('<'));
    assert!(
        !data.contains(char::from_u32(0x2028).unwrap()) && !data.contains(char::from_u32(0x2029).unwrap())
    );
    let parsed: Project = serde_json::from_str(data).unwrap();
    assert_eq!(parsed.title, hostile_title());
    assert_eq!(parsed.items[0].name, hostile_title());

    let basemap = script_body(&html, "pw-basemap").unwrap();
    assert!(!basemap.contains('<'));
    serde_json::from_str::<serde_json::Value>(basemap).unwrap();
}

#[test]
fn html_packs_decode_back_to_the_original_bytes() {
    let f = fixture(5, FullSize::Web);
    let html = write_html(&f, &f.project, &f.opts);
    let parsed: Project = serde_json::from_str(script_body(&html, "pw-data").unwrap()).unwrap();
    let thumbs = script_body(&html, "pw-pack-thumbs").unwrap();
    let fulls = script_body(&html, "pw-pack-full").unwrap();
    for pack in [thumbs, fulls] {
        assert!(!pack.contains(|c: char| c.is_whitespace()), "pack has whitespace");
        assert_eq!(pack.len() % 4, 0);
    }
    assert!(html.contains("data-encoding=\"base64\""));
    for (i, it) in parsed.items.iter().enumerate() {
        let (pack, off, len) = parse_pack_ref(&it.thumb);
        assert_eq!(pack, "thumbs");
        assert_eq!(
            read_pack(thumbs, off, len),
            f.prepared.rendered[i].thumb_jpeg,
            "thumb {i}"
        );
        assert!(it.video.is_none(), "video is never packed");
        match (&it.full, &f.prepared.rendered[i].full) {
            (Some(r), Some(Asset::Bytes { data, .. })) => {
                let (pack, off, len) = parse_pack_ref(r);
                assert_eq!(pack, "full");
                assert_eq!(read_pack(fulls, off, len), *data, "full {i}");
            }
            (None, None) => {}
            other => panic!("item {i}: {other:?}"),
        }
    }
}

#[test]
fn html_without_stills_has_no_full_pack() {
    let f = fixture(2, FullSize::None);
    let html = write_html(&f, &f.project, &f.opts);
    assert!(script_body(&html, "pw-pack-full").is_none());
    assert!(script_body(&html, "pw-pack-thumbs").is_some());
}

#[test]
fn dir_layout_matches_the_contract() {
    let f = fixture(3, FullSize::Web);
    let out = f.dir.path().join("site");
    let rep = bundle::write(&f.prepared, &f.project, Format::Dir, &out, &f.opts, &NoProgress).unwrap();
    for rel in [
        "index.html",
        "data.js",
        "assets/viewer.js",
        "assets/viewer.css",
        "README.txt",
    ] {
        assert!(out.join(rel).is_file(), "{rel}");
    }
    assert!(
        text(&std::fs::read(out.join("README.txt")).unwrap())
            .contains("Unzip first, then double-click index.html")
    );
    let index = std::fs::read_to_string(out.join("index.html")).unwrap();
    assert!(index.contains("<link rel=\"stylesheet\" href=\"assets/viewer.css\">"));
    assert!(index.contains("<script src=\"data.js\"></script>"));
    assert!(index.contains("<script src=\"assets/viewer.js\"></script>"));
    assert!(index.contains("id=\"pw-basemap\""));
    assert!(!index.contains("type=\"module\""));

    let data = std::fs::read_to_string(out.join("data.js")).unwrap();
    let json = data
        .strip_prefix("window.__PHOTOWAY__ = ")
        .unwrap()
        .strip_suffix(";\n")
        .unwrap();
    assert!(!json.contains('<'));
    let parsed: Project = serde_json::from_str(json).unwrap();
    assert_eq!(parsed, f.project);

    let mut total = 0;
    for (i, it) in parsed.items.iter().enumerate() {
        assert_eq!(
            std::fs::read(out.join(&it.thumb)).unwrap(),
            f.prepared.rendered[i].thumb_jpeg
        );
        for r in [&it.full, &it.video].into_iter().flatten() {
            assert!(out.join(r).is_file(), "{r}");
        }
    }
    let mut stack = vec![out.clone()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(d).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                total += e.metadata().unwrap().len();
            }
        }
    }
    assert_eq!(rep.bytes, total);
}

#[test]
fn zip_layout_matches_the_contract_and_leaves_no_temp_file() {
    let f = fixture(3, FullSize::Web);
    let out = f.dir.path().join("trip.zip");
    let rep = bundle::write(&f.prepared, &f.project, Format::Zip, &out, &f.opts, &NoProgress).unwrap();
    assert_eq!(rep.bytes, std::fs::metadata(&out).unwrap().len());
    let leftovers: Vec<_> = std::fs::read_dir(f.dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("part"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
    let names: Vec<String> = zip.file_names().map(|n| n.unwrap().into_owned()).collect();
    for rel in [
        "index.html",
        "data.js",
        "assets/viewer.js",
        "assets/viewer.css",
        "README.txt",
    ] {
        assert!(names.iter().any(|n| n == rel), "{rel} in {names:?}");
    }
    let mut data = String::new();
    zip.by_name("data.js").unwrap().read_to_string(&mut data).unwrap();
    let json = data
        .strip_prefix("window.__PHOTOWAY__ = ")
        .unwrap()
        .strip_suffix(";\n")
        .unwrap();
    let parsed: Project = serde_json::from_str(json).unwrap();
    for (i, it) in parsed.items.iter().enumerate() {
        let mut bytes = Vec::new();
        zip.by_name(&it.thumb).unwrap().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, f.prepared.rendered[i].thumb_jpeg);
        for r in [&it.full, &it.video].into_iter().flatten() {
            assert!(names.contains(r), "{r}");
        }
    }
}

#[test]
fn estimates_are_within_five_percent() {
    for full in [FullSize::None, FullSize::Web, FullSize::Original] {
        let f = fixture(6, full);
        for (format, name) in [
            (Format::Html, "e.html"),
            (Format::Dir, "e-dir"),
            (Format::Zip, "e.zip"),
        ] {
            let out = f.dir.path().join(name);
            let est = bundle::estimate(&f.prepared, &f.project, format, &f.opts) as f64;
            let real = bundle::write(&f.prepared, &f.project, format, &out, &f.opts, &NoProgress)
                .unwrap()
                .bytes as f64;
            assert!(
                (est - real).abs() / real < 0.05,
                "{format:?} {full:?}: estimate {est} vs real {real}"
            );
        }
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn originals_lose_exif_unless_kept() {
    let f = fixture(2, FullSize::Original);
    let rel = f.project.items[0].full.clone().unwrap();
    let source = match &f.prepared.rendered[0].full {
        Some(Asset::File(p)) => std::fs::read(p).unwrap(),
        other => panic!("{other:?}"),
    };
    assert!(contains(&source, b"Exif"));

    let out = f.dir.path().join("stripped");
    bundle::write(&f.prepared, &f.project, Format::Dir, &out, &f.opts, &NoProgress).unwrap();
    let stripped = std::fs::read(out.join(&rel)).unwrap();
    assert!(!contains(&stripped, b"Exif"));
    assert!(stripped.len() < source.len());
    image::load_from_memory(&stripped).unwrap();

    // The rotated item keeps its orientation so it still shows upright.
    let rotated = std::fs::read(out.join(f.project.items[1].full.as_deref().unwrap())).unwrap();
    assert!(contains(&rotated, b"Exif"));

    let kept = f.dir.path().join("kept");
    let keep = ExportOptions {
        strip_exif: false,
        ..f.opts.clone()
    };
    bundle::write(&f.prepared, &f.project, Format::Dir, &kept, &keep, &NoProgress).unwrap();
    assert_eq!(std::fs::read(kept.join(&rel)).unwrap(), source);
}

#[test]
fn asset_for_ref_finds_media_and_rejects_unknown_refs() {
    let f = fixture(2, FullSize::Web);
    let it = &f.project.items[0];
    let asset = bundle::asset_for_ref(&f.prepared, &f.project, it.full.as_deref().unwrap()).unwrap();
    assert!(matches!(asset, Asset::Bytes { ext: "jpg", .. }));
    let video = f.project.items.iter().find(|i| i.video.is_some()).unwrap();
    let asset = bundle::asset_for_ref(&f.prepared, &f.project, video.video.as_deref().unwrap()).unwrap();
    assert!(matches!(asset, Asset::File(_)));
    assert!(bundle::asset_for_ref(&f.prepared, &f.project, "media/nope.jpg").is_none());
    assert!(bundle::asset_for_ref(&f.prepared, &f.project, "../x").is_none());
    assert_eq!(
        bundle::thumb_for_ref(&f.prepared, &f.project, &it.thumb).unwrap(),
        f.prepared.rendered[0].thumb_jpeg.as_slice()
    );
}

struct CancelAfter(AtomicBool);

impl Progress for CancelAfter {
    fn update(&self, done: u64, _: u64, _: &str) {
        if done >= 1 {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[test]
fn cancellation_stops_the_write_and_removes_partial_files() {
    let f = fixture(4, FullSize::Web);
    for (format, name) in [(Format::Zip, "c.zip"), (Format::Html, "c.html")] {
        let out = f.dir.path().join(name);
        let err = bundle::write(
            &f.prepared,
            &f.project,
            format,
            &out,
            &f.opts,
            &CancelAfter(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        assert!(!out.exists());
        let part = f.dir.path().join(format!("{name}.photoway-part"));
        assert!(!part.exists());
    }
}

#[test]
fn progress_reports_every_unit() {
    struct Count(std::sync::Mutex<Vec<(u64, u64)>>);
    impl Progress for Count {
        fn update(&self, done: u64, total: u64, _: &str) {
            self.0.lock().unwrap().push((done, total));
        }
    }
    let f = fixture(2, FullSize::None);
    let p = Count(Default::default());
    bundle::write(
        &f.prepared,
        &f.project,
        Format::Dir,
        &f.dir.path().join("p"),
        &f.opts,
        &p,
    )
    .unwrap();
    let calls = p.0.lock().unwrap();
    assert!(calls.len() >= f.project.items.len());
    assert_eq!(calls.last().unwrap().0, calls.last().unwrap().1);
}

#[test]
fn unsafe_refs_are_rejected() {
    let f = fixture(1, FullSize::None);
    for bad in ["../evil.jpg", "/abs.jpg", "a/../../b.jpg", "a\\b.jpg", "C:/x.jpg"] {
        let mut p = f.project.clone();
        p.items[0].thumb = bad.into();
        let err = bundle::write(
            &f.prepared,
            &p,
            Format::Dir,
            &f.dir.path().join("u"),
            &f.opts,
            &NoProgress,
        );
        assert!(err.is_err(), "{bad}");
    }
    assert!(!f.dir.path().join("evil.jpg").exists());
}
