//! Walk input paths and classify media files. Owner: Wave 1 · A.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use crate::meta::{self, Meta};
use crate::model::Kind;
use crate::{Error, Progress, Result};

pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "dng"];
pub const VIDEO_EXTS: &[&str] = &["mov", "mp4", "m4v"];

/// Still formats that can be the photo half of a Live Photo, in pairing priority order.
const LIVE_STILL_EXTS: &[&str] = &["heic", "heif", "jpg", "jpeg"];

#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// Descend into sub-directories of input folders.
    pub recursive: bool,
    /// Pair HEIC/JPEG stills with same-named MOV clips into `Kind::Live`.
    pub pair_live_photos: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            pair_live_photos: true,
        }
    }
}

/// One usable (geotagged) media entry found by [`scan`].
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: PathBuf,
    /// Motion clip of a Live Photo, if paired.
    pub motion: Option<PathBuf>,
    pub meta: Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    NoLocation,
    Unreadable,
    Unsupported,
    Duplicate,
}

#[derive(Debug, Clone, Default)]
pub struct ScanReport {
    /// Sorted by capture instant (unknown last), ties by path.
    pub entries: Vec<Entry>,
    /// Sorted by path.
    pub skipped: Vec<(PathBuf, SkipReason)>,
}

#[derive(Hash, PartialEq, Eq)]
struct MediaFingerprint {
    kind: u8,
    still: (u64, u64),
    motion: Option<(u64, u64)>,
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn is_media(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| IMAGE_EXTS.contains(&e.as_str()) || VIDEO_EXTS.contains(&e.as_str()))
}

/// Files the OS or Apple tools litter next to media: dot-files (`.DS_Store`, AppleDouble `._*`),
/// `Thumbs.db`, `desktop.ini`, and the `__MACOSX` folder of zip extractions.
fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("thumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
        || name == "__MACOSX"
}

#[cfg(windows)]
fn has_hidden_attr(md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM
    md.file_attributes() & 0x6 != 0
}

#[cfg(not(windows))]
fn has_hidden_attr(_: &std::fs::Metadata) -> bool {
    false
}

struct Collector<'a> {
    opts: &'a ScanOptions,
    progress: &'a dyn Progress,
    files: Vec<PathBuf>,
    skipped: Vec<(PathBuf, SkipReason)>,
    seen_files: HashSet<PathBuf>,
    seen_dirs: HashSet<PathBuf>,
}

impl Collector<'_> {
    fn check_cancel(&self) -> Result<()> {
        if self.progress.cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }

    fn add_file(&mut self, path: PathBuf) {
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if self.seen_files.insert(key) {
            self.files.push(path);
        } else {
            self.skipped.push((path, SkipReason::Duplicate));
        }
    }

    fn input(&mut self, path: &Path) -> Result<()> {
        self.check_cancel()?;
        let Ok(md) = std::fs::metadata(path) else {
            self.skipped.push((path.to_path_buf(), SkipReason::Unreadable));
            return Ok(());
        };
        if md.is_dir() {
            return self.walk(path);
        }
        let hidden = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(is_hidden_name);
        if hidden {
            return Ok(());
        }
        if is_media(path) {
            self.add_file(path.to_path_buf());
        } else {
            self.skipped.push((path.to_path_buf(), SkipReason::Unsupported));
        }
        Ok(())
    }

    fn walk(&mut self, dir: &Path) -> Result<()> {
        self.check_cancel()?;
        // Guards against symlink/junction cycles and a folder listed twice.
        let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        if !self.seen_dirs.insert(key) {
            return Ok(());
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            self.skipped.push((dir.to_path_buf(), SkipReason::Unreadable));
            return Ok(());
        };
        let mut children: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        children.sort();
        for path in children {
            let hidden_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_none_or(is_hidden_name);
            if hidden_name {
                continue;
            }
            let Ok(md) = std::fs::metadata(&path) else {
                self.skipped.push((path, SkipReason::Unreadable));
                continue;
            };
            if has_hidden_attr(&md) {
                continue;
            }
            if md.is_dir() {
                if self.opts.recursive {
                    self.walk(&path)?;
                }
            } else if is_media(&path) {
                self.add_file(path);
            } else {
                self.skipped.push((path, SkipReason::Unsupported));
            }
        }
        Ok(())
    }
}

/// A file to read, with its Live Photo motion clip when paired.
struct Unit {
    path: PathBuf,
    motion: Option<PathBuf>,
}

/// Prefer Apple's shared content identifier, then a same-folder filename match when an
/// identifier is absent. Conflicting identifiers must never be paired by filename.
fn build_units(mut files: Vec<PathBuf>, pair: bool) -> Vec<Unit> {
    files.sort();
    if !pair {
        return files
            .into_iter()
            .map(|path| Unit { path, motion: None })
            .collect();
    }
    let key = |p: &Path| {
        (
            p.parent().map(Path::to_path_buf).unwrap_or_default(),
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
        )
    };
    let mut stills = Vec::new();
    let mut movs_by_stem = HashMap::new();
    let mut movs_by_id = HashMap::new();
    let mut ids = HashMap::new();
    for p in &files {
        let ext = ext_lower(p).unwrap_or_default();
        if ext == "mov" {
            movs_by_stem.entry(key(p)).or_insert(p);
            if let Some(id) = meta::content_identifier(p) {
                movs_by_id.entry(id.clone()).or_insert(p);
                ids.insert(p, id);
            }
        } else if let Some(rank) = LIVE_STILL_EXTS.iter().position(|e| *e == ext) {
            stills.push((rank, p));
            if let Some(id) = meta::content_identifier(p) {
                ids.insert(p, id);
            }
        }
    }
    stills.sort_by_key(|(rank, p)| (*rank, *p));
    let mut motion_of = HashMap::new();
    let mut consumed = HashSet::new();
    for (_, still) in stills {
        let by_id = ids.get(still).and_then(|id| movs_by_id.get(id)).copied();
        let by_stem = movs_by_stem
            .get(&key(still))
            .copied()
            .filter(|mov| !matches!((ids.get(still), ids.get(*mov)), (Some(a), Some(b)) if a != b));
        if let Some(mov) = by_id.or(by_stem)
            && consumed.insert(mov.clone())
        {
            motion_of.insert(still.clone(), mov.clone());
        }
    }
    files
        .into_iter()
        .filter(|p| !consumed.contains(p))
        .map(|path| {
            let motion = motion_of.get(&path).cloned();
            Unit { path, motion }
        })
        .collect()
}

struct Outcome {
    entry: Option<Entry>,
    skipped: Vec<(PathBuf, SkipReason)>,
}

fn read_unit(unit: &Unit) -> Outcome {
    let classify = |path: &Path| match meta::read(path) {
        Ok(Some(meta)) => (Some(meta), None),
        Ok(None) => (None, Some(SkipReason::NoLocation)),
        Err(_) => (None, Some(SkipReason::Unreadable)),
    };
    let (still, still_reason) = classify(&unit.path);
    let Some(motion_path) = &unit.motion else {
        return Outcome {
            entry: still.map(|meta| Entry {
                path: unit.path.clone(),
                motion: None,
                meta,
            }),
            skipped: still_reason
                .map(|r| vec![(unit.path.clone(), r)])
                .unwrap_or_default(),
        };
    };
    let (clip, clip_reason) = classify(motion_path);
    let mut skipped = Vec::new();
    let entry = match (still, clip) {
        (Some(mut m), clip) => {
            if clip_reason == Some(SkipReason::Unreadable) {
                skipped.push((motion_path.clone(), SkipReason::Unreadable));
                Some(Entry {
                    path: unit.path.clone(),
                    motion: None,
                    meta: m,
                })
            } else {
                m.kind = Kind::Live;
                m.dur = clip.and_then(|c| c.dur).or(m.dur);
                Some(Entry {
                    path: unit.path.clone(),
                    motion: Some(motion_path.clone()),
                    meta: m,
                })
            }
        }
        (None, Some(mut m)) if still_reason == Some(SkipReason::NoLocation) => {
            // The clip can supply location and time for an otherwise valid still.
            m.kind = Kind::Live;
            Some(Entry {
                path: unit.path.clone(),
                motion: Some(motion_path.clone()),
                meta: m,
            })
        }
        (None, Some(m)) => {
            skipped.push((unit.path.clone(), SkipReason::Unreadable));
            Some(Entry {
                path: motion_path.clone(),
                motion: None,
                meta: m,
            })
        }
        (None, None) => {
            skipped.push((unit.path.clone(), still_reason.unwrap_or(SkipReason::Unreadable)));
            skipped.push((motion_path.clone(), clip_reason.unwrap_or(SkipReason::Unreadable)));
            None
        }
    };
    Outcome { entry, skipped }
}

/// Walks `inputs` (files or folders) and reads metadata from every media file found.
///
/// Output order is deterministic regardless of thread scheduling or input order. Files reached
/// twice, and byte-identical files are reported as [`SkipReason::Duplicate`].
pub fn scan(inputs: &[PathBuf], opts: &ScanOptions, progress: &dyn Progress) -> Result<ScanReport> {
    let mut c = Collector {
        opts,
        progress,
        files: Vec::new(),
        skipped: Vec::new(),
        seen_files: HashSet::new(),
        seen_dirs: HashSet::new(),
    };
    for input in inputs {
        c.input(input)?;
    }
    let Collector {
        files, mut skipped, ..
    } = c;

    let units = build_units(files, opts.pair_live_photos);
    let total = units.len() as u64;
    let done = AtomicU64::new(0);
    progress.update(0, total, "");
    let outcomes: Vec<Result<Outcome>> = units
        .par_iter()
        .map(|unit| {
            if progress.cancelled() {
                return Err(Error::Cancelled);
            }
            let out = read_unit(unit);
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            let label = unit.path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            progress.update(n, total, label);
            Ok(out)
        })
        .collect();

    let mut entries = Vec::new();
    for outcome in outcomes {
        let outcome = outcome?;
        if let Some(entry) = outcome.entry {
            entries.push(entry);
        }
        skipped.extend(outcome.skipped);
    }
    if progress.cancelled() {
        return Err(Error::Cancelled);
    }

    entries.sort_by(|a, b| {
        (a.meta.ts.is_none(), a.meta.ts, &a.path).cmp(&(b.meta.ts.is_none(), b.meta.ts, &b.path))
    });

    let mut seen: HashMap<MediaFingerprint, Vec<Entry>> = HashMap::new();
    let mut kept = Vec::with_capacity(entries.len());
    for e in entries {
        let key = file_fingerprint(&e.path)
            .and_then(|still| {
                let motion = e.motion.as_deref().map(file_fingerprint).transpose()?;
                let kind = match e.meta.kind {
                    Kind::Photo => 0,
                    Kind::Video => 1,
                    Kind::Live => 2,
                };
                Ok(MediaFingerprint { kind, still, motion })
            })
            .ok();
        let Some(key) = key else {
            kept.push(e);
            continue;
        };
        let peers = seen.entry(key).or_default();
        let dup = peers.iter().any(|p| {
            p.meta.kind == e.meta.kind
                && files_equal(&p.path, &e.path).unwrap_or(false)
                && match (&p.motion, &e.motion) {
                    (None, None) => true,
                    (Some(a), Some(b)) => files_equal(a, b).unwrap_or(false),
                    _ => false,
                }
        });
        if dup {
            skipped.push((e.path, SkipReason::Duplicate));
        } else {
            peers.push(e.clone());
            kept.push(e);
        }
    }

    skipped.sort_by(|a, b| a.0.cmp(&b.0));
    skipped.dedup();
    Ok(ScanReport {
        entries: kept,
        skipped,
    })
}

fn file_fingerprint(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::hash::Hasher;
    use std::io::Read;
    let mut file = std::io::BufReader::new(std::fs::File::open(path)?);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut size = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.write(&buf[..n]);
        size += n as u64;
    }
    Ok((size, hasher.finish()))
}

fn files_equal(a: &Path, b: &Path) -> std::io::Result<bool> {
    use std::io::Read;
    let mut a = std::io::BufReader::new(std::fs::File::open(a)?);
    let mut b = std::io::BufReader::new(std::fs::File::open(b)?);
    let mut left = [0u8; 64 * 1024];
    let mut right = [0u8; 64 * 1024];
    loop {
        let n = a.read(&mut left)?;
        if n != b.read(&mut right)? || left[..n] != right[..n] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn is_media_is_case_insensitive() {
        assert!(is_media(&p("a/IMG_1.HEIC")));
        assert!(is_media(&p("a/clip.Mov")));
        assert!(!is_media(&p("a/notes.txt")));
        assert!(!is_media(&p("a/noext")));
    }

    #[test]
    fn hidden_names() {
        for n in [
            ".DS_Store",
            "._IMG_1.jpg",
            "Thumbs.db",
            "THUMBS.DB",
            "desktop.ini",
            "__MACOSX",
        ] {
            assert!(is_hidden_name(n), "{n}");
        }
        assert!(!is_hidden_name("IMG_1.jpg"));
    }

    #[test]
    fn pairing_by_stem() {
        let files = vec![
            p("d/IMG_1.HEIC"),
            p("d/IMG_1.JPG"),
            p("d/img_1.mov"),
            p("d/IMG_2.heic"),
            p("d/IMG_3.mov"),
            p("e/IMG_2.mov"),
        ];
        let units = build_units(files, true);
        let got: Vec<_> = units
            .iter()
            .map(|u| {
                (
                    u.path.to_str().unwrap(),
                    u.motion.as_ref().map(|m| m.to_str().unwrap()),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("d/IMG_1.HEIC", Some("d/img_1.mov")),
                ("d/IMG_1.JPG", None),
                ("d/IMG_2.heic", None),
                ("d/IMG_3.mov", None),
                ("e/IMG_2.mov", None),
            ]
        );
        assert!(
            build_units(vec![p("d/a.heic"), p("d/a.mov")], false)
                .iter()
                .all(|u| u.motion.is_none())
        );
    }
}
