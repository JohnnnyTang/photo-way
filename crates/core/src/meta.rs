//! Read location, capture time and dimensions from photos and videos. Owner: Wave 1 · A.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use chrono::{DateTime, Datelike, FixedOffset, Local, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use nom_exif::{Exif, ExifDateTime, ExifTag, IfdIndex, MediaKind, MediaParser, MediaSource, TrackInfoTag};

use crate::model::{Kind, TsSource};
use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub kind: Kind,
    pub lat: f64,
    pub lon: f64,
    pub alt: Option<f64>,
    /// Capture time as ISO-8601 (with offset when known).
    pub time: Option<String>,
    /// UTC epoch milliseconds.
    pub ts: Option<i64>,
    pub ts_source: Option<TsSource>,
    /// Local calendar date `YYYY-MM-DD`.
    pub day: Option<String>,
    /// Display dimensions after orientation.
    pub w: u32,
    pub h: u32,
    /// EXIF orientation 1–8 (1 when unknown).
    pub orientation: u8,
    pub dur: Option<f64>,
}

/// Returns `Ok(None)` when the file is readable but has no location.
pub fn read(path: &Path) -> Result<Option<Meta>> {
    let ms = MediaSource::open(path).map_err(convert_err)?;
    let kind = ms.kind();
    let mut parser = MediaParser::new();
    match kind {
        MediaKind::Image => read_image(path, ms, &mut parser),
        MediaKind::Track => read_video(path, ms, &mut parser),
    }
}

fn convert_err(e: nom_exif::Error) -> Error {
    match e {
        nom_exif::Error::Io(e) => Error::Io(e),
        e => Error::Other(anyhow::anyhow!("{e}")),
    }
}

fn read_image(path: &Path, ms: MediaSource<File>, parser: &mut MediaParser) -> Result<Option<Meta>> {
    let iter = match parser.parse_exif(ms) {
        Ok(iter) => iter,
        Err(nom_exif::Error::ExifNotFound) => return Ok(None),
        Err(e) => return Err(convert_err(e)),
    };
    let exif: Exif = iter.into();
    let Some(gps) = exif.gps_info() else {
        return Ok(None);
    };
    let (Some(lat), Some(lon)) = (gps.latitude_decimal(), gps.longitude_decimal()) else {
        return Ok(None);
    };
    if !valid_location(lat, lon) {
        return Ok(None);
    }
    let alt = gps.altitude_meters().filter(|a| a.is_finite());

    let orientation = exif
        .get(ExifTag::Orientation)
        .and_then(|v| v.as_u16())
        .filter(|o| (1..=8).contains(o))
        .map_or(1, |o| o as u8);

    let (w, h) = stored_dims(path, &exif).unwrap_or((0, 0));
    let (w, h) = display_dims(w, h, orientation);

    let mut raw = RawTimes::default();
    let captured = exif
        .get(ExifTag::DateTimeOriginal)
        .or_else(|| exif.get(ExifTag::CreateDate))
        .and_then(|v| v.as_datetime());
    match captured {
        Some(ExifDateTime::Aware(dt)) => {
            raw.local = Some(dt.naive_local());
            raw.offset = Some(*dt.offset());
        }
        Some(ExifDateTime::Naive(n)) => raw.local = Some(n),
        None => {}
    }
    let date = exif
        .get_in(IfdIndex::MAIN, ExifTag::GPSDateStamp)
        .and_then(|v| v.as_str());
    let time = exif
        .get_in(IfdIndex::MAIN, ExifTag::GPSTimeStamp)
        .and_then(|v| v.as_urational_slice())
        .map(|s| s.iter().map(|r| r.to_f64()).collect::<Vec<_>>());
    if let (Some(date), Some(time)) = (date, time) {
        raw.gps_utc = parse_gps_datetime(date, &time);
    }
    raw.file = file_mtime(path);

    Ok(Some(build(
        Kind::Photo,
        lat,
        lon,
        alt,
        raw,
        w,
        h,
        orientation,
        None,
    )))
}

fn read_video(path: &Path, ms: MediaSource<File>, parser: &mut MediaParser) -> Result<Option<Meta>> {
    let info = match parser.parse_track(ms) {
        Ok(info) => info,
        Err(nom_exif::Error::TrackNotFound) => return Ok(None),
        Err(e) => return Err(convert_err(e)),
    };
    let from_iso = info
        .get(TrackInfoTag::GpsIso6709)
        .and_then(|v| v.as_str())
        .and_then(parse_iso6709);
    let (lat, lon, alt) = match from_iso {
        Some(loc) => loc,
        None => match info.gps_info() {
            Some(g) => match (g.latitude_decimal(), g.longitude_decimal()) {
                (Some(lat), Some(lon)) => (lat, lon, g.altitude_meters()),
                _ => return Ok(None),
            },
            None => return Ok(None),
        },
    };
    if !valid_location(lat, lon) {
        return Ok(None);
    }

    let mut raw = RawTimes::default();
    // The mvhd creation time is UTC with no zone, while the Apple creationdate key carries the
    // local offset. An implausibly old value is an unset (zero) mvhd field.
    if let Some(ExifDateTime::Aware(dt)) = info.get(TrackInfoTag::CreateDate).and_then(|v| v.as_datetime())
        && dt.year() >= 1980
    {
        if dt.offset().local_minus_utc() == 0 {
            raw.gps_utc = Some(dt.naive_utc());
        } else {
            raw.local = Some(dt.naive_local());
            raw.offset = Some(*dt.offset());
        }
    }
    raw.file = file_mtime(path);

    let dur = info
        .get(TrackInfoTag::DurationMs)
        .and_then(|v| v.as_u64())
        .map(|ms| ms as f64 / 1000.0);
    let (w, h) = video_display_dims(path).unwrap_or_else(|| {
        let get = |t| info.get(t).and_then(|v| v.as_u32()).unwrap_or(0);
        (get(TrackInfoTag::Width), get(TrackInfoTag::Height))
    });

    Ok(Some(build(Kind::Video, lat, lon, alt, raw, w, h, 1, dur)))
}

#[allow(clippy::too_many_arguments)]
fn build(
    kind: Kind,
    lat: f64,
    lon: f64,
    alt: Option<f64>,
    raw: RawTimes,
    w: u32,
    h: u32,
    orientation: u8,
    dur: Option<f64>,
) -> Meta {
    let t = resolve_time(&raw);
    Meta {
        kind,
        lat,
        lon,
        alt,
        time: t.time,
        ts: t.ts,
        ts_source: t.source,
        day: t.day,
        w,
        h,
        orientation,
        dur,
    }
}

/// Stored (pre-orientation) pixel size: decoded header first, EXIF tags as fallback.
/// DNG and HEIC are skipped by the header probe (DNG's first IFD is a thumbnail; the `image`
/// crate has no HEIC support), so those rely on `ExifImageWidth/Height`.
fn stored_dims(path: &Path, exif: &Exif) -> Option<(u32, u32)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(ext.as_str(), "dng" | "heic" | "heif")
        && let Some(d) = image::ImageReader::open(path)
            .ok()
            .and_then(|r| r.with_guessed_format().ok())
            .and_then(|r| r.into_dimensions().ok())
        && d.0 > 0
        && d.1 > 0
    {
        return Some(d);
    }
    let get = |a: ExifTag, b: ExifTag| {
        let v = |t| exif.get(t).and_then(|v| v.try_as_integer()).filter(|n| *n > 0);
        Some((u32::try_from(v(a)?).ok()?, u32::try_from(v(b)?).ok()?))
    };
    get(ExifTag::ExifImageWidth, ExifTag::ExifImageHeight)
        .or_else(|| get(ExifTag::ImageWidth, ExifTag::ImageHeight))
}

/// Swaps width and height for the transposing orientations 5–8.
pub fn display_dims(w: u32, h: u32, orientation: u8) -> (u32, u32) {
    if (5..=8).contains(&orientation) {
        (h, w)
    } else {
        (w, h)
    }
}

fn valid_location(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && lat.abs() <= 90.0
        && lon.abs() <= 180.0
        && !(lat == 0.0 && lon == 0.0)
}

/// Parses an ISO 6709 point (`+27.5916+086.5640+8850CRSWGS_84/`, also `±DDMM.mm`/`±DDMMSS.ss`
/// forms) into `(lat, lon, alt)`. Out-of-range and (0, 0) points are not rejected here.
pub fn parse_iso6709(s: &str) -> Option<(f64, f64, Option<f64>)> {
    let s = s.trim().trim_end_matches('/');
    let s = &s[..s.find('C').unwrap_or(s.len())];
    let mut toks: Vec<&str> = Vec::new();
    let mut start = None;
    for (i, c) in s.char_indices() {
        if c == '+' || c == '-' {
            if let Some(st) = start {
                toks.push(&s[st..i]);
            }
            start = Some(i);
        }
    }
    if let Some(st) = start {
        toks.push(&s[st..]);
    }
    if !(2..=3).contains(&toks.len()) {
        return None;
    }
    let lat = iso_angle(toks[0], 2)?;
    let lon = iso_angle(toks[1], 3)?;
    let alt = match toks.get(2) {
        Some(t) => Some(t.parse::<f64>().ok().filter(|a| a.is_finite())?),
        None => None,
    };
    Some((lat, lon, alt))
}

fn iso_angle(tok: &str, deg_digits: usize) -> Option<f64> {
    let sign = if tok.starts_with('-') { -1.0 } else { 1.0 };
    let body = &tok[1..];
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    let int_len = body.find('.').unwrap_or(body.len());
    let part = |a: usize, b: usize| body.get(a..b).and_then(|p| p.parse::<f64>().ok());
    let value = match int_len.checked_sub(deg_digits)? {
        0 => part(0, body.len())?,
        2 => {
            let m = part(deg_digits, body.len())?;
            if m >= 60.0 {
                return None;
            }
            part(0, deg_digits)? + m / 60.0
        }
        4 => {
            let m = part(deg_digits, deg_digits + 2)?;
            let sec = part(deg_digits + 2, body.len())?;
            if m >= 60.0 || sec >= 60.0 {
                return None;
            }
            part(0, deg_digits)? + m / 60.0 + sec / 3600.0
        }
        _ => return None,
    };
    Some(sign * value)
}

/// `YYYY:MM:DD` (or `-` separated) plus `[h, m, s]` rationals into a naive UTC datetime.
fn parse_gps_datetime(date: &str, hms: &[Option<f64>]) -> Option<NaiveDateTime> {
    let date = date.trim().trim_end_matches('\0');
    let date = NaiveDate::parse_from_str(date, "%Y:%m:%d")
        .or_else(|_| NaiveDate::parse_from_str(date, "%Y-%m-%d"))
        .ok()?;
    let [Some(h), Some(m), Some(s)] = hms else {
        return None;
    };
    let time = NaiveTime::from_hms_milli_opt(*h as u32, *m as u32, *s as u32, (s.fract() * 1000.0) as u32)?;
    Some(date.and_time(time))
}

fn file_mtime(path: &Path) -> Option<DateTime<FixedOffset>> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let local: DateTime<Local> = modified.into();
    Some(local.fixed_offset())
}

/// Raw clock readings found in a file.
#[derive(Debug, Default, Clone)]
pub(crate) struct RawTimes {
    /// Camera-local wall-clock time (`DateTimeOriginal`).
    pub local: Option<NaiveDateTime>,
    /// Zone of `local` (`OffsetTimeOriginal`, or the Apple creation date).
    pub offset: Option<FixedOffset>,
    /// GPS date/time stamp, which is UTC.
    pub gps_utc: Option<NaiveDateTime>,
    /// File modification time; the last resort.
    pub file: Option<DateTime<FixedOffset>>,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Resolved {
    pub time: Option<String>,
    pub ts: Option<i64>,
    pub source: Option<TsSource>,
    pub day: Option<String>,
}

const NAIVE_FMT: &str = "%Y-%m-%dT%H:%M:%S";
const AWARE_FMT: &str = "%Y-%m-%dT%H:%M:%S%:z";
const DAY_FMT: &str = "%Y-%m-%d";

/// Decides the capture instant (D7): offset-aware local time, else GPS UTC stamp, else the local
/// time treated as UTC, else file mtime.
///
/// - `day` is always the *local* calendar date. With a GPS stamp and a local time, the local
///   time supplies the date; with a GPS stamp alone it can only be the UTC date.
/// - With both GPS and local time, the zone is inferred from their difference when it is a
///   plausible whole quarter-hour (cameras with a slightly wrong clock yield a naive `time`).
pub(crate) fn resolve_time(raw: &RawTimes) -> Resolved {
    if let (Some(local), Some(off)) = (raw.local, raw.offset)
        && let Some(dt) = local.and_local_timezone(off).single()
    {
        return Resolved {
            time: Some(dt.format(AWARE_FMT).to_string()),
            ts: Some(dt.timestamp_millis()),
            source: Some(TsSource::Offset),
            day: Some(local.format(DAY_FMT).to_string()),
        };
    }
    if let Some(utc) = raw.gps_utc {
        let ts = Some(utc.and_utc().timestamp_millis());
        let source = Some(TsSource::Gps);
        return match raw.local {
            Some(local) => {
                let diff = (local - utc).num_seconds();
                let rounded = (diff as f64 / 900.0).round() as i64 * 900;
                let off = FixedOffset::east_opt(rounded as i32)
                    .filter(|_| (diff - rounded).abs() <= 300 && rounded.abs() <= 14 * 3600);
                let time = match off.and_then(|o| local.and_local_timezone(o).single()) {
                    Some(dt) => dt.format(AWARE_FMT).to_string(),
                    None => local.format(NAIVE_FMT).to_string(),
                };
                Resolved {
                    time: Some(time),
                    ts,
                    source,
                    day: Some(local.format(DAY_FMT).to_string()),
                }
            }
            None => Resolved {
                time: Some(utc.and_utc().format(AWARE_FMT).to_string()),
                ts,
                source,
                day: Some(utc.format(DAY_FMT).to_string()),
            },
        };
    }
    if let Some(local) = raw.local {
        return Resolved {
            time: Some(local.format(NAIVE_FMT).to_string()),
            ts: Some(local.and_utc().timestamp_millis()),
            source: Some(TsSource::Naive),
            day: Some(local.format(DAY_FMT).to_string()),
        };
    }
    if let Some(dt) = raw.file {
        return Resolved {
            time: Some(dt.format(AWARE_FMT).to_string()),
            ts: Some(dt.with_timezone(&Utc).timestamp_millis()),
            source: Some(TsSource::File),
            day: Some(dt.format(DAY_FMT).to_string()),
        };
    }
    Resolved::default()
}

// ---- ISO base media (MP4/MOV) track header ----

/// Child boxes of `data` as `(type, body)`; stops at the first malformed box.
fn child_boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        let typ: [u8; 4] = data[pos + 4..pos + 8].try_into().unwrap();
        let (hdr, total) = match size {
            0 => (8, data.len() - pos),
            1 => {
                let Some(big) = data.get(pos + 8..pos + 16) else {
                    break;
                };
                (16, u64::from_be_bytes(big.try_into().unwrap()) as usize)
            }
            n => (8, n),
        };
        if total < hdr || pos + total > data.len() {
            break;
        }
        out.push((typ, &data[pos + hdr..pos + total]));
        pos += total;
    }
    out
}

/// Display size (rotation applied) of the first track with non-zero dimensions in a `moov` body.
pub(crate) fn tkhd_display_dims(moov: &[u8]) -> Option<(u32, u32)> {
    for (typ, trak) in child_boxes(moov) {
        if &typ != b"trak" {
            continue;
        }
        for (typ, tkhd) in child_boxes(trak) {
            if &typ != b"tkhd" {
                continue;
            }
            let base = if *tkhd.first()? == 1 { 52 } else { 40 };
            let m = tkhd.get(base..base + 44)?;
            let i = |o: usize| i32::from_be_bytes(m[o..o + 4].try_into().unwrap());
            let (a, b, c, d) = (i(0), i(4), i(12), i(16));
            let w = u32::from_be_bytes(m[36..40].try_into().unwrap()) >> 16;
            let h = u32::from_be_bytes(m[40..44].try_into().unwrap()) >> 16;
            if w == 0 || h == 0 {
                continue;
            }
            let rotated = a == 0 && d == 0 && b != 0 && c != 0;
            return Some(if rotated { (h, w) } else { (w, h) });
        }
    }
    None
}

fn video_display_dims(path: &Path) -> Option<(u32, u32)> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let mut head = [0u8; 16];
        f.read_exact(&mut head[..8]).ok()?;
        let size = u32::from_be_bytes(head[..4].try_into().unwrap()) as u64;
        let (hdr, total) = match size {
            0 => (8, len - pos),
            1 => {
                f.read_exact(&mut head[8..]).ok()?;
                (16, u64::from_be_bytes(head[8..].try_into().unwrap()))
            }
            n => (8, n),
        };
        if total < hdr {
            return None;
        }
        if &head[4..8] == b"moov" {
            let body = total - hdr;
            if body > 64 << 20 || pos + total > len {
                return None;
            }
            let mut buf = vec![0u8; body as usize];
            f.seek(SeekFrom::Start(pos + hdr)).ok()?;
            f.read_exact(&mut buf).ok()?;
            return tkhd_display_dims(&buf);
        }
        pos += total;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ndt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, NAIVE_FMT).unwrap()
    }

    fn ms(s: &str) -> i64 {
        ndt(s).and_utc().timestamp_millis()
    }

    #[test]
    fn iso6709_forms() {
        let (lat, lon, alt) = parse_iso6709("+27.5916+086.5640+8850CRSWGS_84/").unwrap();
        assert_eq!((lat, lon, alt), (27.5916, 86.564, Some(8850.0)));
        let (lat, lon, alt) = parse_iso6709("+37.7858-122.4064/").unwrap();
        assert_eq!((lat, lon, alt), (37.7858, -122.4064, None));
        let (lat, lon, alt) = parse_iso6709("-33.8688+151.2093-12.5/").unwrap();
        assert_eq!((lat, lon, alt), (-33.8688, 151.2093, Some(-12.5)));
        // DDMM.mm and DDMMSS.ss
        let (lat, lon, _) = parse_iso6709("+4852.00+00221.00/").unwrap();
        assert!((lat - 48.866_666).abs() < 1e-5 && (lon - 2.35).abs() < 1e-9);
        let (lat, lon, _) = parse_iso6709("+485200-0022100/").unwrap();
        assert!((lat - 48.866_666).abs() < 1e-5 && (lon + 2.35).abs() < 1e-9);
    }

    #[test]
    fn iso6709_rejects_garbage() {
        for s in [
            "",
            "/",
            "+27.5",
            "abc",
            "+27.5916",
            "+2.5+10.5/",
            "+27.5x+86.5/",
            "+4899.00+00221.00/",
        ] {
            assert_eq!(parse_iso6709(s), None, "{s}");
        }
    }

    #[test]
    fn location_validation() {
        assert!(valid_location(27.5, 86.5));
        assert!(!valid_location(0.0, 0.0));
        assert!(!valid_location(91.0, 0.0));
        assert!(!valid_location(0.0, 181.0));
        assert!(!valid_location(f64::NAN, 1.0));
    }

    #[test]
    fn orientation_swaps_dimensions() {
        for o in 1..=4 {
            assert_eq!(display_dims(4000, 3000, o), (4000, 3000));
        }
        for o in 5..=8 {
            assert_eq!(display_dims(4000, 3000, o), (3000, 4000));
        }
    }

    #[test]
    fn time_prefers_offset() {
        let raw = RawTimes {
            local: Some(ndt("2026-07-23T23:30:00")),
            offset: FixedOffset::east_opt(8 * 3600),
            gps_utc: Some(ndt("2026-07-23T10:00:00")),
            ..Default::default()
        };
        let r = resolve_time(&raw);
        assert_eq!(r.source, Some(TsSource::Offset));
        assert_eq!(r.time.as_deref(), Some("2026-07-23T23:30:00+08:00"));
        assert_eq!(r.day.as_deref(), Some("2026-07-23"));
        assert_eq!(r.ts, Some(ms("2026-07-23T15:30:00")));
    }

    #[test]
    fn time_gps_only_uses_utc_date() {
        let raw = RawTimes {
            gps_utc: Some(ndt("2026-07-23T23:30:00")),
            ..Default::default()
        };
        let r = resolve_time(&raw);
        assert_eq!(r.source, Some(TsSource::Gps));
        assert_eq!(r.day.as_deref(), Some("2026-07-23"));
        assert_eq!(r.time.as_deref(), Some("2026-07-23T23:30:00+00:00"));
    }

    #[test]
    fn time_gps_with_local_infers_zone_and_local_day() {
        // 23:30 UTC is already the next day at UTC+8.
        let raw = RawTimes {
            local: Some(ndt("2026-07-24T07:31:10")),
            gps_utc: Some(ndt("2026-07-23T23:30:00")),
            ..Default::default()
        };
        let r = resolve_time(&raw);
        assert_eq!(r.source, Some(TsSource::Gps));
        assert_eq!(r.day.as_deref(), Some("2026-07-24"));
        assert_eq!(r.time.as_deref(), Some("2026-07-24T07:31:10+08:00"));
        assert_eq!(r.ts, Some(ms("2026-07-23T23:30:00")));
    }

    #[test]
    fn time_gps_with_implausible_zone_stays_naive() {
        let raw = RawTimes {
            local: Some(ndt("2026-07-24T07:00:00")),
            gps_utc: Some(ndt("2026-07-23T23:07:00")),
            ..Default::default()
        };
        let r = resolve_time(&raw);
        assert_eq!(r.time.as_deref(), Some("2026-07-24T07:00:00"));
    }

    #[test]
    fn time_naive_is_treated_as_utc() {
        let raw = RawTimes {
            local: Some(ndt("2026-07-23T10:32:15")),
            ..Default::default()
        };
        let r = resolve_time(&raw);
        assert_eq!(r.source, Some(TsSource::Naive));
        assert_eq!(r.time.as_deref(), Some("2026-07-23T10:32:15"));
        assert_eq!(r.ts, Some(ms("2026-07-23T10:32:15")));
    }

    #[test]
    fn time_file_is_last_resort() {
        let file = DateTime::parse_from_rfc3339("2026-01-02T03:04:05+02:00").unwrap();
        let r = resolve_time(&RawTimes {
            file: Some(file),
            ..Default::default()
        });
        assert_eq!(r.source, Some(TsSource::File));
        assert_eq!(r.day.as_deref(), Some("2026-01-02"));
        assert_eq!(r.ts, Some(file.timestamp_millis()));
        assert_eq!(resolve_time(&RawTimes::default()), Resolved::default());
    }

    #[test]
    fn gps_datetime_parsing() {
        let t = [Some(10.0), Some(5.0), Some(30.5)];
        let dt = parse_gps_datetime("2026:07:23", &t).unwrap();
        assert_eq!(
            dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            "2026-07-23 10:05:30.500"
        );
        assert!(parse_gps_datetime("garbage", &t).is_none());
        assert!(parse_gps_datetime("2026:07:23", &[Some(25.0), Some(0.0), Some(0.0)]).is_none());
        assert!(parse_gps_datetime("2026:07:23", &[None, Some(0.0), Some(0.0)]).is_none());
    }

    fn boxed(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    fn tkhd(w: u32, h: u32, m: [i32; 4]) -> Vec<u8> {
        let mut b = vec![0u8; 40];
        for v in [m[0], m[1], 0, m[2], m[3], 0, 0, 0, 0x4000_0000] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        b.extend_from_slice(&(w << 16).to_be_bytes());
        b.extend_from_slice(&(h << 16).to_be_bytes());
        boxed(b"tkhd", &b)
    }

    #[test]
    fn tkhd_rotation() {
        const ID: [i32; 4] = [0x10000, 0, 0, 0x10000];
        const ROT90: [i32; 4] = [0, 0x10000, -0x10000, 0];
        let audio = boxed(b"trak", &tkhd(0, 0, ID));
        let video = boxed(b"trak", &tkhd(1920, 1080, ID));
        let moov = [audio.clone(), video].concat();
        assert_eq!(tkhd_display_dims(&moov), Some((1920, 1080)));
        let rotated = [audio, boxed(b"trak", &tkhd(1920, 1080, ROT90))].concat();
        assert_eq!(tkhd_display_dims(&rotated), Some((1080, 1920)));
        assert_eq!(tkhd_display_dims(&[]), None);
        assert_eq!(
            tkhd_display_dims(&boxed(b"trak", &boxed(b"tkhd", &[0; 10]))),
            None
        );
    }
}
