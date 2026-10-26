//! Tauri commands: a thin layer over photoway-core.
//!
//! Long work runs on a background thread. Progress and results travel as events:
//! `pw-progress` `{phase, done, total, label}` and `pw-finished`
//! `{phase, ok, cancelled, code?, params?, message?, data?}` where `phase` is `scan`, `process` or `export`.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use photoway_core::bundle::{self, ExportOptions, Format};
use photoway_core::media::{self, Prepared};
use photoway_core::model::{Kind, Project};
use photoway_core::scan::{self, ScanOptions, ScanReport};
use photoway_core::serve::{self, ServerHandle};
use photoway_core::{Error, Progress};
use serde_json::{Value, json};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::photos_import::{self, ImportRequest};
use crate::protocol::{self, Snapshot};
use crate::settings::{self, Settings};
use crate::summary;

const MAX_LISTED_ERRORS: usize = 50;

#[derive(Default)]
pub struct Session {
    inputs: Vec<PathBuf>,
    report: Option<Arc<ScanReport>>,
    prepared: Option<Arc<Prepared>>,
    project: Option<Arc<Project>>,
    /// Bumped whenever the preview content changes.
    version: u64,
    cache_dir: Option<PathBuf>,
    /// Temporary Photos exports remain available until Start over or app exit.
    imports: Vec<tempfile::TempDir>,
}

pub struct AppState {
    session: Mutex<Session>,
    busy: AtomicBool,
    cancel: Arc<AtomicBool>,
    server: Mutex<Option<ServerHandle>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(Session::default()),
            busy: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            server: Mutex::new(None),
        }
    }

    fn session(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// What the `pw` protocol handler needs, without holding the lock while serving.
    pub fn snapshot(&self) -> Snapshot {
        let s = self.session();
        Snapshot {
            report: s.report.clone(),
            prepared: s.prepared.clone(),
            project: s.project.clone(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Human-readable text for a core error.
pub fn describe(e: &Error) -> String {
    match e {
        Error::Unimplemented(what) => format!("{what} is not available in this build yet."),
        other => other.to_string(),
    }
}

fn error_code(e: &Error) -> &'static str {
    match e {
        Error::Cancelled => "cancelled",
        Error::Unimplemented(_) => "unimplemented",
        Error::Io(_) => "io",
        Error::Other(_) => "other",
    }
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown error".into())
}

struct EventProgress {
    app: AppHandle,
    phase: &'static str,
    cancel: Arc<AtomicBool>,
    last: Mutex<Option<Instant>>,
}

impl Progress for EventProgress {
    fn update(&self, done: u64, total: u64, label: &str) {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        let due = last.is_none_or(|t| t.elapsed() >= Duration::from_millis(60));
        if due || done >= total {
            *last = Some(Instant::now());
            let _ = self.app.emit(
                "pw-progress",
                json!({ "phase": self.phase, "done": done, "total": total, "label": label }),
            );
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// Runs `work` on a background thread and reports its result as `pw-finished`.
fn spawn_op<F>(app: &AppHandle, phase: &'static str, work: F) -> Result<(), String>
where
    F: FnOnce(&AppHandle, &EventProgress) -> Result<Value, Error> + Send + 'static,
{
    let state = app.state::<AppState>();
    if state
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Another operation is still running.".into());
    }
    state.cancel.store(false, Ordering::Relaxed);
    let progress = EventProgress {
        app: app.clone(),
        phase,
        cancel: state.cancel.clone(),
        last: Mutex::new(None),
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let result = catch_unwind(AssertUnwindSafe(|| work(&app, &progress)));
        app.state::<AppState>().busy.store(false, Ordering::Release);
        let payload = match result {
            Ok(Ok(data)) => json!({ "phase": phase, "ok": true, "cancelled": false, "data": data }),
            Ok(Err(Error::Cancelled)) => {
                json!({ "phase": phase, "ok": false, "cancelled": true, "code": "cancelled" })
            }
            Ok(Err(e)) => {
                let params = match &e {
                    Error::Unimplemented(feature) => json!({ "feature": feature }),
                    _ => json!({}),
                };
                json!({ "phase": phase, "ok": false, "cancelled": false,
                    "code": error_code(&e), "params": params, "message": describe(&e) })
            }
            Err(p) => json!({
                "phase": phase, "ok": false, "cancelled": false,
                "code": "unexpected", "params": {},
                "message": format!("Unexpected error: {}", panic_text(p.as_ref())),
            }),
        };
        let _ = app.emit("pw-finished", payload);
    });
    Ok(())
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("media"))
}

fn parse_format(s: &str) -> Result<Format, String> {
    match s {
        "html" => Ok(Format::Html),
        "dir" => Ok(Format::Dir),
        "zip" => Ok(Format::Zip),
        other => Err(format!("Unknown export format: {other}")),
    }
}

/// `bundle::project` guarded against the not-yet-implemented stub (it panics).
fn build_project(report: &ScanReport, prepared: &Prepared, opts: &ExportOptions) -> Result<Project, Error> {
    catch_unwind(AssertUnwindSafe(|| bundle::project(report, prepared, opts))).map_err(|p| {
        Error::Other(anyhow::anyhow!(
            "The export engine failed: {}",
            panic_text(p.as_ref())
        ))
    })
}

fn estimates(prepared: &Prepared, project: &Project, opts: &ExportOptions) -> Value {
    let est =
        |f| catch_unwind(AssertUnwindSafe(|| bundle::estimate(prepared, project, f, opts))).unwrap_or(0);
    json!({ "html": est(Format::Html), "dir": est(Format::Dir), "zip": est(Format::Zip) })
}

/// Rebuilds the project from the current scan and media, stores it for the preview and
/// returns `{version, items, estimates}`. `keep_id` preserves the previous project id so
/// the viewer's local edits survive option tweaks.
fn rebuild(app: &AppHandle, settings: &Settings, keep_id: bool) -> Result<Value, Error> {
    let state = app.state::<AppState>();
    let (report, prepared, previous) = {
        let s = state.session();
        (s.report.clone(), s.prepared.clone(), s.project.clone())
    };
    let (Some(report), Some(prepared)) = (report, prepared) else {
        return Err(Error::Other(anyhow::anyhow!("Nothing has been processed yet.")));
    };
    let opts = settings.export_options();
    let mut project = build_project(&report, &prepared, &opts)?;
    if keep_id && let Some(prev) = previous {
        project.id = prev.id.clone();
        project.created_at = prev.created_at.clone();
    }
    let est = estimates(&prepared, &project, &opts);
    let items = project.items.len();
    let mut s = state.session();
    s.project = Some(Arc::new(project));
    s.version += 1;
    Ok(json!({ "version": s.version, "items": items, "estimates": est }))
}

#[tauri::command]
pub fn app_info() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "previewUrl": protocol::url_for("preview.html"),
        "macos": cfg!(target_os = "macos")
    })
}

#[tauri::command]
pub fn open_photos() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .args(["-a", "Photos"])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Could not open Photos.app.".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Photos.app is available on macOS only.".into())
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    config_dir(&app).map(|d| settings::load(&d)).unwrap_or_default()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    settings::save(&config_dir(&app)?, &settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_menu_language(app: AppHandle, language: String) -> Result<(), String> {
    let locale = if language == "zh-CN" { "zh-CN" } else { "en" };
    let menu = crate::menu::build(&app, locale).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cancel(state: tauri::State<'_, AppState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

/// Forgets the current scan (the "start over" action).
#[tauri::command]
pub fn reset(state: tauri::State<'_, AppState>) {
    let mut s = state.session();
    let cache_dir = s.cache_dir.take();
    let imports = std::mem::take(&mut s.imports);
    *s = Session {
        cache_dir,
        version: s.version + 1,
        ..Session::default()
    };
    drop(s);
    // Large Photos imports may contain gigabytes; do not block the UI during deletion.
    std::thread::spawn(move || drop(imports));
}

/// Scans `paths` (added to the earlier ones when `append`). Result: a [`summary::Summary`].
#[tauri::command]
pub fn scan(app: AppHandle, paths: Vec<String>, append: bool) -> Result<(), String> {
    let new: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let cache = cache_dir(&app);
    spawn_op(&app, "scan", move |app, progress| {
        let state = app.state::<AppState>();
        let mut inputs = if append {
            state.session().inputs.clone()
        } else {
            Vec::new()
        };
        for p in new {
            if !inputs.contains(&p) {
                inputs.push(p);
            }
        }
        let report = scan::scan(&inputs, &ScanOptions::default(), progress)?;
        let pending: Vec<usize> = match &cache {
            Some(dir) => report
                .entries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.meta.kind == Kind::Video && !media::has_poster(dir, &e.path))
                .map(|(i, _)| i)
                .collect(),
            None => Vec::new(),
        };
        let summary = summary::build(&report, pending);
        let mut s = state.session();
        s.inputs = inputs;
        s.report = Some(Arc::new(report));
        s.prepared = None;
        s.project = None;
        s.cache_dir = cache;
        s.version += 1;
        serde_json::to_value(summary).map_err(|e| Error::Other(e.into()))
    })
}

/// Exports Photos.app originals to session-owned temporary storage, ready for the usual scanner.
#[tauri::command]
pub fn import_photos(app: AppHandle, request: ImportRequest) -> Result<(), String> {
    request.validate()?;
    spawn_op(&app, "import", move |app, progress| {
        progress.update(0, 0, "Photos");
        let imported = photos_import::run(&request, &progress.cancel, |done, total| {
            progress.update(done, total, "Photos")
        })
        .map_err(|e| {
            if e == "cancelled" {
                Error::Cancelled
            } else {
                Error::Other(anyhow::anyhow!(e))
            }
        })?;
        let count = imported.count;
        if count == 0 {
            return Ok(json!({ "count": 0 }));
        }
        let path = photos_import::export_path(&imported.directory);
        app.state::<AppState>().session().imports.push(imported.directory);
        Ok(json!({ "count": count, "path": path.display().to_string() }))
    })
}

/// Stores a poster frame (JPEG or PNG bytes as the raw request body) for scan entry `index`.
#[tauri::command]
pub fn set_poster(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    let index: usize = request
        .headers()
        .get("index")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("missing index header")?;
    let (report, cache) = {
        let state = app.state::<AppState>();
        let s = state.session();
        (s.report.clone(), s.cache_dir.clone())
    };
    let report = report.ok_or("nothing scanned")?;
    let cache = cache.ok_or("no cache directory")?;
    let entry = report.entries.get(index).ok_or("no such entry")?;
    media::set_poster(&cache, &entry.path, bytes).map_err(|e| describe(&e))
}

/// Renders thumbnails and full-size media for the scanned entries, then builds the project.
#[tauri::command]
pub fn process(app: AppHandle, settings: Settings) -> Result<(), String> {
    let cache = cache_dir(&app);
    spawn_op(&app, "process", move |app, progress| {
        let state = app.state::<AppState>();
        let report = state
            .session()
            .report
            .clone()
            .ok_or_else(|| Error::Other(anyhow::anyhow!("Add some photos first.")))?;
        let prepared = media::process(&report, &settings.media_options(cache), progress)?;
        let errors: Vec<Value> = prepared
            .errors
            .iter()
            .take(MAX_LISTED_ERRORS)
            .map(|e| json!({ "path": e.path.display().to_string(), "message": e.message }))
            .collect();
        let error_count = prepared.errors.len();
        {
            let mut s = state.session();
            s.prepared = Some(Arc::new(prepared));
            s.project = None;
        }
        let mut data = rebuild(app, &settings, false)?;
        data["errors"] = Value::Array(errors);
        data["errorCount"] = json!(error_count);
        Ok(data)
    })
}

/// Rebuilds the project after option changes (title, theme, basemap, precision) without
/// re-rendering media. Returns `{version, items, estimates}`.
#[tauri::command]
pub async fn refresh_project(app: AppHandle, settings: Settings) -> Result<Value, String> {
    rebuild(&app, &settings, true).map_err(|e| describe(&e))
}

/// Writes the export. `format` is `html`, `dir` or `zip`; result `{path, bytes}`.
#[tauri::command]
pub fn export(app: AppHandle, format: String, out: String, settings: Settings) -> Result<(), String> {
    let format = parse_format(&format)?;
    let out = PathBuf::from(out);
    spawn_op(&app, "export", move |app, progress| {
        let state = app.state::<AppState>();
        let (report, prepared) = {
            let s = state.session();
            (s.report.clone(), s.prepared.clone())
        };
        let (Some(report), Some(prepared)) = (report, prepared) else {
            return Err(Error::Other(anyhow::anyhow!("Nothing has been processed yet.")));
        };
        let opts = settings.export_options();
        let project = build_project(&report, &prepared, &opts)?;
        let done = bundle::write(&prepared, &project, format, &out, &opts, progress)?;
        Ok(json!({ "path": done.path.display().to_string(), "bytes": done.bytes }))
    })
}

fn browser_target(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.join("index.html")
    } else {
        path.to_path_buf()
    }
}

#[tauri::command]
pub fn open_in_browser(app: AppHandle, path: String) -> Result<(), String> {
    let target = browser_target(Path::new(&path));
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// Starts a local server for an export and returns its URL.
#[tauri::command]
pub fn serve_start(app: AppHandle, path: String) -> Result<String, String> {
    let state = app.state::<AppState>();
    let mut slot = state.server.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = slot.take() {
        old.stop();
    }
    let addr = "127.0.0.1:0"
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    let handle = serve::serve(Path::new(&path), addr).map_err(|e| describe(&e))?;
    let url = handle.url();
    *slot = Some(handle);
    Ok(url)
}

#[tauri::command]
pub fn serve_stop(state: tauri::State<'_, AppState>) {
    let mut slot = state.server.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = slot.take() {
        handle.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unimplemented_errors_read_naturally() {
        let msg = describe(&Error::Unimplemented("bundle::write"));
        assert_eq!(msg, "bundle::write is not available in this build yet.");
        assert_eq!(describe(&Error::Cancelled), "operation cancelled");
    }

    #[test]
    fn formats_parse() {
        assert_eq!(parse_format("zip"), Ok(Format::Zip));
        assert!(parse_format("pdf").is_err());
    }

    #[test]
    fn directory_exports_open_their_index() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(browser_target(dir.path()), dir.path().join("index.html"));
        let f = dir.path().join("trip.html");
        assert_eq!(browser_target(&f), f);
    }

    #[test]
    fn guarded_project_build_turns_the_stub_panic_into_an_error() {
        let result = catch_unwind(AssertUnwindSafe(|| {
            build_project(
                &ScanReport::default(),
                &Prepared::default(),
                &ExportOptions::default(),
            )
        }));
        // Either the real engine (an Ok project) or the stub (an Err): never a panic.
        assert!(result.is_ok());
    }
}
