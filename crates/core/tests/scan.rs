mod common;

use std::sync::atomic::{AtomicU64, Ordering};

use common::{Gps, Mov, Shot, TempDir, write_jpeg, write_mov};
use photoway_core::meta;
use photoway_core::model::{Kind, TsSource};
use photoway_core::scan::{ScanOptions, SkipReason, scan};
use photoway_core::{Error, NoProgress, Progress};

fn opts() -> ScanOptions {
    ScanOptions {
        recursive: true,
        pair_live_photos: true,
    }
}

fn geo(lat: f64, lon: f64) -> Option<Gps> {
    Some(Gps::at(lat, lon))
}

fn shot(w: u32, h: u32, local: &'static str, gps: Option<Gps>) -> Shot {
    Shot {
        local: Some(local),
        gps,
        ..Shot::new(w, h)
    }
}

#[test]
fn reads_offset_time_gps_and_dimensions() {
    let dir = TempDir::new("offset");
    let path = dir.join("a.jpg");
    let s = Shot {
        offset: Some("+08:00"),
        gps: Some(Gps {
            alt: Some(1234.5),
            ..Gps::at(30.25, -120.5)
        }),
        ..shot(64, 32, "2026:07:23 23:30:00", None)
    };
    write_jpeg(&path, &s, 10);
    let m = meta::read(&path).unwrap().unwrap();
    assert_eq!(m.kind, Kind::Photo);
    assert!(
        (m.lat - 30.25).abs() < 1e-6 && (m.lon + 120.5).abs() < 1e-6,
        "{m:?}"
    );
    assert!((m.alt.unwrap() - 1234.5).abs() < 0.01);
    assert_eq!(m.ts_source, Some(TsSource::Offset));
    assert_eq!(m.time.as_deref(), Some("2026-07-23T23:30:00+08:00"));
    assert_eq!(m.day.as_deref(), Some("2026-07-23"));
    assert_eq!(m.ts, Some(1_784_820_600_000));
    assert_eq!((m.w, m.h, m.orientation), (64, 32, 1));
}

#[test]
fn southern_and_western_hemispheres_are_negative() {
    let dir = TempDir::new("hemi");
    let path = dir.join("a.jpg");
    write_jpeg(&path, &shot(8, 8, "2026:01:01 00:00:00", geo(-33.8688, -70.5)), 1);
    let m = meta::read(&path).unwrap().unwrap();
    assert!((m.lat + 33.8688).abs() < 1e-4 && (m.lon + 70.5).abs() < 1e-6);
}

#[test]
fn orientation_swaps_display_dimensions() {
    let dir = TempDir::new("orient");
    for (o, expect) in [(1u16, (64, 32)), (3, (64, 32)), (6, (32, 64)), (8, (32, 64))] {
        let path = dir.join(&format!("o{o}.jpg"));
        let s = Shot {
            orientation: Some(o),
            ..shot(64, 32, "2026:07:23 10:00:00", geo(10.0, 20.0))
        };
        write_jpeg(&path, &s, 1);
        let m = meta::read(&path).unwrap().unwrap();
        assert_eq!((m.w, m.h), expect, "orientation {o}");
        assert_eq!(m.orientation, o as u8);
    }
}

#[test]
fn gps_timestamp_beats_naive_and_sets_local_day() {
    let dir = TempDir::new("gpsts");
    let path = dir.join("a.jpg");
    let s = shot(
        8,
        8,
        "2026:07:24 07:31:10",
        Some(Gps {
            date: Some("2026:07:23"),
            time: Some((23, 30, 0)),
            ..Gps::at(31.0, 121.0)
        }),
    );
    write_jpeg(&path, &s, 1);
    let m = meta::read(&path).unwrap().unwrap();
    assert_eq!(m.ts_source, Some(TsSource::Gps));
    assert_eq!(m.day.as_deref(), Some("2026-07-24"));
    assert_eq!(m.time.as_deref(), Some("2026-07-24T07:31:10+08:00"));
    assert_eq!(m.ts, Some(1_784_849_400_000));
}

#[test]
fn naive_time_and_file_fallback() {
    let dir = TempDir::new("naive");
    let a = dir.join("a.jpg");
    write_jpeg(&a, &shot(8, 8, "2026:07:23 10:32:15", geo(10.0, 20.0)), 1);
    let m = meta::read(&a).unwrap().unwrap();
    assert_eq!(m.ts_source, Some(TsSource::Naive));
    assert_eq!(m.time.as_deref(), Some("2026-07-23T10:32:15"));

    let b = dir.join("b.jpg");
    write_jpeg(
        &b,
        &Shot {
            gps: geo(10.0, 20.0),
            ..Shot::new(8, 8)
        },
        2,
    );
    let m = meta::read(&b).unwrap().unwrap();
    assert_eq!(m.ts_source, Some(TsSource::File));
    assert!(m.ts.is_some() && m.day.is_some());
}

#[test]
fn zero_zero_and_missing_gps_have_no_location() {
    let dir = TempDir::new("noloc");
    let a = dir.join("zero.jpg");
    write_jpeg(&a, &shot(8, 8, "2026:07:23 10:00:00", geo(0.0, 0.0)), 1);
    assert_eq!(meta::read(&a).unwrap(), None);
    let b = dir.join("none.jpg");
    write_jpeg(&b, &shot(8, 8, "2026:07:23 10:00:00", None), 2);
    assert_eq!(meta::read(&b).unwrap(), None);
    let c = dir.join("plain.jpg");
    std::fs::write(&c, common::jpeg_bytes(&Shot::new(8, 8), 3)).unwrap();
    assert!(meta::read(&c).is_ok());
}

#[test]
fn reads_video_location_time_and_rotation() {
    let dir = TempDir::new("mov");
    let path = dir.join("v.mov");
    let m = Mov {
        iso6709: Some("+27.5916+086.5640+8850/"),
        created_unix: 1_784_788_800,
        w: 1920,
        h: 1080,
        rotated: true,
        millis: 2900,
    };
    write_mov(&path, &m);
    let got = meta::read(&path).unwrap().unwrap();
    assert_eq!(got.kind, Kind::Video);
    assert_eq!((got.lat, got.lon, got.alt), (27.5916, 86.564, Some(8850.0)));
    assert_eq!((got.w, got.h), (1080, 1920));
    assert_eq!(got.dur, Some(2.9));
    assert_eq!(got.ts, Some(1_784_788_800_000));
    assert_eq!(got.ts_source, Some(TsSource::Gps));
}

#[test]
fn video_without_location_is_none() {
    let dir = TempDir::new("movnoloc");
    let path = dir.join("v.mov");
    write_mov(
        &path,
        &Mov {
            iso6709: None,
            created_unix: 1_784_788_800,
            w: 8,
            h: 8,
            rotated: false,
            millis: 1000,
        },
    );
    assert_eq!(meta::read(&path).unwrap(), None);
}

#[test]
fn scan_sorts_by_time_unknown_last_with_path_tiebreak() {
    let dir = TempDir::new("sort");
    write_jpeg(
        &dir.join("c.jpg"),
        &shot(8, 8, "2026:07:23 12:00:00", geo(1.0, 1.0)),
        1,
    );
    write_jpeg(
        &dir.join("b.jpg"),
        &shot(8, 8, "2026:07:23 11:00:00", geo(2.0, 2.0)),
        2,
    );
    write_jpeg(
        &dir.join("a.jpg"),
        &shot(8, 8, "2026:07:23 12:00:00", geo(3.0, 3.0)),
        3,
    );
    let r = scan(&[dir.path().to_path_buf()], &opts(), &NoProgress).unwrap();
    let names: Vec<_> = r
        .entries
        .iter()
        .map(|e| e.path.file_name().unwrap().to_str().unwrap())
        .collect();
    assert_eq!(names, ["b.jpg", "a.jpg", "c.jpg"]);
}

#[test]
fn scan_reports_skips_and_ignores_hidden_files() {
    let dir = TempDir::new("skips");
    write_jpeg(
        &dir.join("ok.jpg"),
        &shot(8, 8, "2026:07:23 10:00:00", geo(1.0, 1.0)),
        1,
    );
    write_jpeg(
        &dir.join("noloc.jpg"),
        &shot(8, 8, "2026:07:23 10:00:00", None),
        2,
    );
    std::fs::write(dir.join("broken.jpg"), b"not a jpeg").unwrap();
    std::fs::write(dir.join("notes.txt"), b"hi").unwrap();
    write_jpeg(
        &dir.join("._ok.jpg"),
        &shot(8, 8, "2026:07:23 10:00:00", geo(5.0, 5.0)),
        3,
    );
    write_jpeg(
        &dir.join(".hidden/x.jpg"),
        &shot(8, 8, "2026:07:23 10:00:00", geo(6.0, 6.0)),
        4,
    );
    std::fs::write(dir.join("Thumbs.db"), b"x").unwrap();
    std::fs::write(dir.join(".DS_Store"), b"x").unwrap();

    let txt = dir.join("notes.txt");
    let r = scan(&[dir.path().to_path_buf(), txt.clone()], &opts(), &NoProgress).unwrap();
    assert_eq!(r.entries.len(), 1);
    let reason = |name: &str| {
        r.skipped
            .iter()
            .find(|(p, _)| p.file_name().unwrap() == name)
            .map(|s| s.1)
    };
    assert_eq!(reason("noloc.jpg"), Some(SkipReason::NoLocation));
    assert_eq!(reason("broken.jpg"), Some(SkipReason::Unreadable));
    assert_eq!(reason("notes.txt"), Some(SkipReason::Unsupported));
    assert_eq!(r.skipped.len(), 3, "{:?}", r.skipped);
    assert!(r.skipped.windows(2).all(|w| w[0].0 <= w[1].0));
}

#[test]
fn scan_respects_recursive() {
    let dir = TempDir::new("rec");
    write_jpeg(
        &dir.join("top.jpg"),
        &shot(8, 8, "2026:07:23 10:00:00", geo(1.0, 1.0)),
        1,
    );
    write_jpeg(
        &dir.join("sub/deep.jpg"),
        &shot(8, 8, "2026:07:23 11:00:00", geo(2.0, 2.0)),
        2,
    );
    let flat = ScanOptions {
        recursive: false,
        ..opts()
    };
    assert_eq!(
        scan(&[dir.path().to_path_buf()], &flat, &NoProgress)
            .unwrap()
            .entries
            .len(),
        1
    );
    assert_eq!(
        scan(&[dir.path().to_path_buf()], &opts(), &NoProgress)
            .unwrap()
            .entries
            .len(),
        2
    );
}

#[test]
fn scan_detects_duplicates() {
    let dir = TempDir::new("dups");
    let s = shot(8, 8, "2026:07:23 10:00:00", geo(1.0, 1.0));
    write_jpeg(&dir.join("a.jpg"), &s, 1);
    std::fs::copy(dir.join("a.jpg"), dir.join("copy.jpg")).unwrap();
    // same file reached via folder and as an explicit input
    let a = dir.join("a.jpg");
    let r = scan(&[dir.path().to_path_buf(), a], &opts(), &NoProgress).unwrap();
    assert_eq!(r.entries.len(), 1);
    assert_eq!(r.entries[0].path.file_name().unwrap(), "a.jpg");
    let dups: Vec<_> = r
        .skipped
        .iter()
        .filter(|s| s.1 == SkipReason::Duplicate)
        .collect();
    assert_eq!(dups.len(), 2, "{:?}", r.skipped);

    // same time and place but different content is not a duplicate
    write_jpeg(&dir.join("other.jpg"), &s, 200);
    let r = scan(&[dir.path().to_path_buf()], &opts(), &NoProgress).unwrap();
    assert_eq!(r.entries.len(), 2);
}

#[test]
fn scan_pairs_live_photos() {
    let dir = TempDir::new("live");
    write_jpeg(
        &dir.join("IMG_1.jpg"),
        &shot(8, 8, "2026:07:23 10:00:00", geo(1.0, 1.0)),
        1,
    );
    let clip = Mov {
        iso6709: Some("+01.0000+001.0000/"),
        created_unix: 1_784_788_800,
        w: 8,
        h: 8,
        rotated: false,
        millis: 2900,
    };
    write_mov(&dir.join("img_1.MOV"), &clip);
    write_mov(
        &dir.join("solo.mov"),
        &Mov {
            iso6709: Some("+02.0000+002.0000/"),
            ..clip
        },
    );

    let r = scan(&[dir.path().to_path_buf()], &opts(), &NoProgress).unwrap();
    assert_eq!(r.entries.len(), 2);
    let live = r.entries.iter().find(|e| e.motion.is_some()).unwrap();
    assert_eq!(live.path.file_name().unwrap(), "IMG_1.jpg");
    assert_eq!(live.meta.kind, Kind::Live);
    assert_eq!(live.meta.dur, Some(2.9));
    assert_eq!(
        live.meta.ts_source,
        Some(TsSource::Naive),
        "keeps the still's metadata"
    );
    assert!(
        r.entries
            .iter()
            .any(|e| e.path.file_name().unwrap() == "solo.mov" && e.meta.kind == Kind::Video)
    );
    assert!(
        !r.entries
            .iter()
            .any(|e| e.path.file_name().unwrap() == "img_1.MOV")
    );

    let off = ScanOptions {
        pair_live_photos: false,
        ..opts()
    };
    let r = scan(&[dir.path().to_path_buf()], &off, &NoProgress).unwrap();
    assert_eq!(r.entries.len(), 3);
    assert!(r.entries.iter().all(|e| e.motion.is_none()));
}

#[test]
fn scan_is_deterministic() {
    let dir = TempDir::new("det");
    for i in 0..24u8 {
        let t: &'static str = if i % 3 == 0 {
            "2026:07:23 10:00:00"
        } else {
            "2026:07:23 11:00:00"
        };
        write_jpeg(
            &dir.join(&format!("p{i:02}.jpg")),
            &shot(8, 8, t, geo(1.0 + f64::from(i), 2.0)),
            i,
        );
    }
    let paths = |dirs: &[std::path::PathBuf]| {
        scan(dirs, &opts(), &NoProgress)
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.path)
            .collect::<Vec<_>>()
    };
    let first = paths(&[dir.path().to_path_buf()]);
    for _ in 0..3 {
        assert_eq!(paths(&[dir.path().to_path_buf()]), first);
    }
}

struct CancelAfter(AtomicU64, u64);

impl Progress for CancelAfter {
    fn update(&self, done: u64, _: u64, _: &str) {
        self.0.store(done, Ordering::Relaxed);
    }
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed) >= self.1
    }
}

#[test]
fn scan_can_be_cancelled() {
    let dir = TempDir::new("cancel");
    for i in 0..8u8 {
        write_jpeg(
            &dir.join(&format!("p{i}.jpg")),
            &shot(8, 8, "2026:07:23 10:00:00", geo(1.0 + f64::from(i), 2.0)),
            i,
        );
    }
    let r = scan(
        &[dir.path().to_path_buf()],
        &opts(),
        &CancelAfter(AtomicU64::new(0), 0),
    );
    assert!(matches!(r, Err(Error::Cancelled)));
    let r = scan(
        &[dir.path().to_path_buf()],
        &opts(),
        &CancelAfter(AtomicU64::new(0), 3),
    );
    assert!(matches!(r, Err(Error::Cancelled)));
}

#[test]
fn scan_reports_progress() {
    struct Count(AtomicU64, AtomicU64);
    impl Progress for Count {
        fn update(&self, done: u64, total: u64, _: &str) {
            self.0.fetch_max(done, Ordering::Relaxed);
            self.1.store(total, Ordering::Relaxed);
        }
    }
    let dir = TempDir::new("prog");
    for i in 0..5u8 {
        write_jpeg(
            &dir.join(&format!("p{i}.jpg")),
            &shot(8, 8, "2026:07:23 10:00:00", geo(1.0 + f64::from(i), 2.0)),
            i,
        );
    }
    let c = Count(AtomicU64::new(0), AtomicU64::new(0));
    scan(&[dir.path().to_path_buf()], &opts(), &c).unwrap();
    assert_eq!((c.0.load(Ordering::Relaxed), c.1.load(Ordering::Relaxed)), (5, 5));
}

#[test]
fn missing_input_is_unreadable() {
    let dir = TempDir::new("missing");
    let ghost = dir.path().join("ghost.jpg");
    let r = scan(std::slice::from_ref(&ghost), &opts(), &NoProgress).unwrap();
    assert_eq!(r.skipped, vec![(ghost, SkipReason::Unreadable)]);
}
