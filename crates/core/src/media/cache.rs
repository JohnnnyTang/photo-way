//! Content-hash cache for rendered JPEGs.
//!
//! Layout: `<cache_dir>/<key[..2]>/<key>.<tag>.jpg`. The key is a BLAKE3 hash of the file
//! complete file contents (not the path or modification time, so moved or copied files still
//! hit). The tag encodes the render parameters (size, quality),
//! so changing them never serves stale data.
//!
//! Entries are written to a temporary file and renamed into place; reads validate the JPEG
//! start/end markers, so a truncated or corrupt entry is treated as a miss and rewritten.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone)]
pub(crate) struct Cache {
    dir: PathBuf,
}

impl Cache {
    pub(crate) fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    fn entry_path(&self, key: &str, tag: &str) -> PathBuf {
        self.dir.join(&key[..2]).join(format!("{key}.{tag}.jpg"))
    }

    /// Returns the cached JPEG, or `None` when missing or invalid.
    pub(crate) fn get(&self, key: &str, tag: &str) -> Option<Vec<u8>> {
        let data = fs::read(self.entry_path(key, tag)).ok()?;
        looks_like_jpeg(&data).then_some(data)
    }

    pub(crate) fn contains(&self, key: &str, tag: &str) -> bool {
        self.get(key, tag).is_some()
    }

    /// Best effort: a failing cache must never fail an export.
    pub(crate) fn put(&self, key: &str, tag: &str, data: &[u8]) {
        let _ = self.try_put(key, tag, data);
    }

    fn try_put(&self, key: &str, tag: &str, data: &[u8]) -> io::Result<()> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = self.entry_path(key, tag);
        let parent = path.parent().expect("entry path has a parent");
        fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(
            "{key}.{tag}.{}-{}.tmp",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut f = File::create(&tmp)?;
            f.write_all(data)?;
            f.flush()?;
            drop(f);
            fs::rename(&tmp, &path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
}

fn looks_like_jpeg(data: &[u8]) -> bool {
    data.len() > 4 && data[..2] == [0xFF, 0xD8] && data[data.len() - 2..] == [0xFF, 0xD9]
}

/// Hash every byte: sampling could reuse a stale preview when an edit falls outside the samples.
pub(crate) fn content_key(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex()[..32].to_string())
}

#[cfg(test)]
mod tests {
    use super::content_key;

    #[test]
    fn hashes_full_contents_independent_of_path_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.bin");
        let second = dir.path().join("second.bin");
        let bytes = vec![0u8; 256 * 1024];
        std::fs::write(&first, &bytes).unwrap();
        std::fs::write(&second, &bytes).unwrap();
        let original = content_key(&first).unwrap();
        assert_eq!(original, content_key(&second).unwrap());

        let mut edited = bytes;
        edited[100 * 1024] = 1; // Outside the former head/middle/tail samples.
        std::fs::write(&second, edited).unwrap();
        assert_ne!(original, content_key(&second).unwrap());
    }
}
