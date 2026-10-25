//! macOS Photos.app bridge. Photos owns its library; never inspect the .photoslibrary package.

use std::path::PathBuf;

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub source: String,
    pub start_day: Option<String>,
    pub end_day: Option<String>,
    pub favorites_only: bool,
    pub location_only: bool,
}

impl ImportRequest {
    pub fn validate(&self) -> Result<(), String> {
        match self.source.as_str() {
            "selection" => Ok(()),
            "range" => {
                let start = self.start_day.as_deref().ok_or("Choose a start date.")?;
                let end = self.end_day.as_deref().ok_or("Choose an end date.")?;
                if !valid_day(start) || !valid_day(end) || start > end {
                    return Err("Choose a valid date range, with the start on or before the end.".into());
                }
                Ok(())
            }
            _ => Err("Unknown Photos import source.".into()),
        }
    }
}

fn valid_day(day: &str) -> bool {
    let b = day.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let year = day[0..4].parse::<i32>().unwrap_or(0);
    let month = day[5..7].parse::<u32>().unwrap_or(0);
    let day = day[8..10].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day > 0 && day <= max
}

pub struct Imported {
    pub directory: tempfile::TempDir,
    pub count: usize,
}

#[cfg(target_os = "macos")]
pub fn run(
    request: &ImportRequest,
    cancelled: &std::sync::atomic::AtomicBool,
    on_progress: impl Fn(u64, u64),
) -> Result<Imported, String> {
    use std::process::{Command, Stdio};
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    request.validate()?;
    let directory = tempfile::Builder::new()
        .prefix("photoway-photos-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let script = directory.path().join("import.applescript");
    std::fs::write(&script, include_str!("photos_import.applescript")).map_err(|e| e.to_string())?;
    let export_dir = directory.path().join("originals");
    let progress_file = directory.path().join("progress.txt");
    std::fs::create_dir(&export_dir).map_err(|e| e.to_string())?;

    let mut child = Command::new("osascript")
        .arg(&script)
        .arg(&request.source)
        .arg(request.start_day.as_deref().unwrap_or(""))
        .arg(request.end_day.as_deref().unwrap_or(""))
        .arg(if request.favorites_only { "true" } else { "false" })
        .arg(if request.location_only { "true" } else { "false" })
        .arg(&export_dir)
        .arg(&progress_file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Photos automation: {e}"))?;
    let mut reported = None;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        if let Ok(contents) = std::fs::read_to_string(&progress_file) {
            let mut parts = contents.split_whitespace().filter_map(|s| s.parse::<u64>().ok());
            if let (Some(done), Some(total)) = (parts.next(), parts.next()) {
                if reported != Some((done, total)) {
                    on_progress(done, total);
                    reported = Some((done, total));
                }
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(script);
    let _ = std::fs::remove_file(progress_file);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(format!(
            "Photos could not export originals: {detail}. Allow Photo Way to control Photos in System Settings → Privacy & Security → Automation."
        ));
    }
    let count = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<usize>()
        .map_err(|_| "Photos returned an unexpected import result.".to_string())?;
    if count > 0 {
        let mut exported = 0;
        for batch in std::fs::read_dir(&export_dir).map_err(|e| e.to_string())? {
            let batch = batch.map_err(|e| e.to_string())?;
            if batch.file_type().map_err(|e| e.to_string())?.is_dir() {
                exported += std::fs::read_dir(batch.path())
                    .map_err(|e| e.to_string())?
                    .count();
            }
        }
        if exported < count {
            return Err(format!(
                "Photos selected {count} items but exported only {exported} files. Retry the import; the partial copy was discarded."
            ));
        }
    }
    Ok(Imported { directory, count })
}

#[cfg(not(target_os = "macos"))]
pub fn run(
    _request: &ImportRequest,
    _cancelled: &std::sync::atomic::AtomicBool,
    _on_progress: impl Fn(u64, u64),
) -> Result<Imported, String> {
    Err("Photos import is available on macOS only.".into())
}

pub fn export_path(directory: &tempfile::TempDir) -> PathBuf {
    directory.path().join("originals")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_real_calendar_days() {
        assert!(valid_day("2024-02-29"));
        assert!(!valid_day("2025-02-29"));
        assert!(!valid_day("2025-13-01"));
        assert!(!valid_day("2025-04-31"));
        assert!(!valid_day("2025-01-01junk"));
        let request = ImportRequest {
            source: "range".into(),
            start_day: Some("2025-05-02".into()),
            end_day: Some("2025-05-01".into()),
            favorites_only: false,
            location_only: false,
        };
        assert!(request.validate().is_err());
    }
}
