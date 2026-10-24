//! What the UI shows after a scan.

use photoway_core::model::Kind;
use photoway_core::scan::{ScanReport, SkipReason};
use serde::Serialize;

/// Skipped files listed per reason are capped so the event payload stays small.
const MAX_LISTED: usize = 300;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkipGroup {
    pub reason: &'static str,
    pub label: &'static str,
    pub count: usize,
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Files examined: usable entries plus skipped ones.
    pub found: usize,
    /// Items with a location, i.e. the ones that will appear on the map.
    pub with_location: usize,
    pub photos: usize,
    pub videos: usize,
    pub live: usize,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
    pub skipped: Vec<SkipGroup>,
    /// Entry indices of videos that still need a poster frame (D6).
    pub pending_posters: Vec<usize>,
}

fn reason_key(r: SkipReason) -> (&'static str, &'static str) {
    match r {
        SkipReason::NoLocation => ("noLocation", "No location data"),
        SkipReason::Unreadable => ("unreadable", "Could not be read"),
        SkipReason::Unsupported => ("unsupported", "Unsupported file type"),
        SkipReason::Duplicate => ("duplicate", "Duplicates"),
    }
}

pub fn build(report: &ScanReport, pending_posters: Vec<usize>) -> Summary {
    let count = |k: Kind| report.entries.iter().filter(|e| e.meta.kind == k).count();
    let days = report.entries.iter().filter_map(|e| e.meta.day.as_deref());
    let first_day = days.clone().min().map(str::to_owned);
    let last_day = days.max().map(str::to_owned);

    let mut skipped: Vec<SkipGroup> = Vec::new();
    for (path, reason) in &report.skipped {
        let (reason, label) = reason_key(*reason);
        let index = match skipped.iter().position(|g| g.reason == reason) {
            Some(i) => i,
            None => {
                skipped.push(SkipGroup {
                    reason,
                    label,
                    count: 0,
                    files: Vec::new(),
                });
                skipped.len() - 1
            }
        };
        let group = &mut skipped[index];
        group.count += 1;
        if group.files.len() < MAX_LISTED {
            group.files.push(path.display().to_string());
        }
    }
    Summary {
        found: report.entries.len() + report.skipped.len(),
        with_location: report.entries.len(),
        photos: count(Kind::Photo),
        videos: count(Kind::Video),
        live: count(Kind::Live),
        first_day,
        last_day,
        skipped,
        pending_posters,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use photoway_core::meta::Meta;
    use photoway_core::scan::Entry;

    use super::*;

    fn entry(name: &str, kind: Kind, day: Option<&str>) -> Entry {
        Entry {
            path: PathBuf::from(name),
            motion: None,
            meta: Meta {
                kind,
                lat: 1.0,
                lon: 2.0,
                alt: None,
                time: None,
                ts: None,
                ts_source: None,
                day: day.map(str::to_owned),
                w: 10,
                h: 10,
                orientation: 1,
                dur: None,
            },
        }
    }

    #[test]
    fn counts_kinds_dates_and_groups_skips_by_reason() {
        let report = ScanReport {
            entries: vec![
                entry("a.jpg", Kind::Photo, Some("2026-07-02")),
                entry("b.mov", Kind::Video, Some("2026-07-01")),
                entry("c.heic", Kind::Live, None),
                entry("d.jpg", Kind::Photo, Some("2026-07-09")),
            ],
            skipped: vec![
                (PathBuf::from("x.jpg"), SkipReason::NoLocation),
                (PathBuf::from("y.txt"), SkipReason::Unsupported),
                (PathBuf::from("z.jpg"), SkipReason::NoLocation),
            ],
        };
        let s = build(&report, vec![1]);
        assert_eq!((s.found, s.with_location), (7, 4));
        assert_eq!((s.photos, s.videos, s.live), (2, 1, 1));
        assert_eq!(s.first_day.as_deref(), Some("2026-07-01"));
        assert_eq!(s.last_day.as_deref(), Some("2026-07-09"));
        assert_eq!(s.skipped.len(), 2);
        assert_eq!(s.skipped[0].reason, "noLocation");
        assert_eq!(s.skipped[0].count, 2);
        assert_eq!(s.skipped[0].files.len(), 2);
        assert_eq!(s.pending_posters, vec![1]);
    }

    #[test]
    fn empty_report_has_no_dates_and_caps_listed_files() {
        let s = build(&ScanReport::default(), vec![]);
        assert_eq!((s.found, s.first_day, s.last_day), (0, None, None));
        let many = ScanReport {
            entries: vec![],
            skipped: (0..MAX_LISTED + 5)
                .map(|i| (PathBuf::from(format!("{i}.jpg")), SkipReason::NoLocation))
                .collect(),
        };
        let g = &build(&many, vec![]).skipped[0];
        assert_eq!((g.count, g.files.len()), (MAX_LISTED + 5, MAX_LISTED));
    }
}
