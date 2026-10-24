//! Shared fixture for the bundle and serve tests: a few generated geotagged JPEGs and a video,
//! scanned and rendered through the real pipeline.
#![allow(dead_code)]

use photoway_core::NoProgress;
use photoway_core::bundle::{self, ExportOptions};
use photoway_core::media::{self, FullSize, MediaOptions, Prepared};
use photoway_core::model::Project;
use photoway_core::scan::{self, ScanOptions, ScanReport};

use crate::common::{Gps, Mov, Shot, TempDir, write_jpeg, write_mov};

pub struct Fixture {
    pub dir: TempDir,
    pub report: ScanReport,
    pub prepared: Prepared,
    pub project: Project,
    pub opts: ExportOptions,
}

/// `photos` JPEGs (EXIF with GPS and time, every other one rotated) plus one MOV video.
pub fn fixture(photos: usize, full: FullSize) -> Fixture {
    let dir = TempDir::new("export");
    for i in 0..photos {
        let shot = Shot {
            orientation: (i % 2 == 1).then_some(6),
            local: Some("2026:07:23 10:00:00"),
            offset: Some("+08:00"),
            gps: Some(Gps::at(30.123456789 + i as f64 * 0.01, -120.987654321)),
            ..Shot::new(320, 240)
        };
        write_jpeg(
            &dir.join(&format!("photos/IMG_{i:04}.jpg")),
            &shot,
            (i * 37 % 200) as u8 + 20,
        );
    }
    write_mov(
        &dir.join("clips/CLIP_0001.mov"),
        &Mov {
            iso6709: Some("+30.5000-120.5000/"),
            created_unix: 1_784_800_000,
            w: 64,
            h: 48,
            rotated: false,
            millis: 1500,
            live_id: None,
        },
    );
    let report = scan::scan(&[dir.path().to_path_buf()], &ScanOptions::default(), &NoProgress).unwrap();
    assert_eq!(report.entries.len(), photos + 1, "{:?}", report.skipped);
    let media_opts = MediaOptions {
        full,
        ..MediaOptions::default()
    };
    let prepared = media::process(&report, &media_opts, &NoProgress).unwrap();
    let opts = ExportOptions {
        title: "Fixture trip".into(),
        ..ExportOptions::default()
    };
    let project = bundle::project(&report, &prepared, &opts);
    Fixture {
        dir,
        report,
        prepared,
        project,
        opts,
    }
}
