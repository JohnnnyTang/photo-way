//! The `pw` custom URI scheme: serves the viewer, the live project and its media to the preview.
//!
//! Layout (relative to the scheme root):
//! - `preview.html`, `preview.js`, `viewer.js`, `viewer.css`, `project.json`
//! - `ref/<bundle ref>`  media of the current project (via `bundle::asset_for_ref`)
//! - `src/<n>`           the original file of scan entry `n` (video poster capture, D6)
//!
//! Windows (WebView2) reaches a custom scheme as `http://pw.localhost/...`, macOS and Linux
//! as `pw://localhost/...`; [`base_url`] picks the right one. The preview page itself only
//! uses relative URLs, so it works under either shape.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

use photoway_core::assets;
use photoway_core::bundle;
use photoway_core::media::Asset;
use photoway_core::model::Project;
use photoway_core::scan::ScanReport;

pub const SCHEME: &str = "pw";

/// Origin of the scheme as the webview of this platform addresses it.
pub fn base_url() -> &'static str {
    if cfg!(windows) {
        "http://pw.localhost"
    } else {
        "pw://localhost"
    }
}

/// Absolute URL of `rel` (no leading slash) under the scheme.
pub fn url_for(rel: &str) -> String {
    format!("{}/{}", base_url(), rel.trim_start_matches('/'))
}

/// The URL a bundle ref has in the preview, e.g. `thumbs/00000.jpg` becomes `<base>/ref/thumbs/00000.jpg`.
#[allow(dead_code)] // the preview page builds the relative form itself; kept for tests and tooling
pub fn ref_url(rel: &str) -> String {
    url_for(&format!("ref/{}", encode_path(rel)))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    PreviewHtml,
    PreviewJs,
    ViewerJs,
    ViewerCss,
    ProjectJson,
    Ref(String),
    Src(usize),
    NotFound,
}

/// Maps a request path (leading slash, still percent-encoded) to a [`Route`].
pub fn route(path: &str) -> Route {
    let path = path.trim_start_matches('/');
    match path {
        "" | "preview.html" => Route::PreviewHtml,
        "preview.js" => Route::PreviewJs,
        "viewer.js" => Route::ViewerJs,
        "viewer.css" => Route::ViewerCss,
        "project.json" => Route::ProjectJson,
        _ => {
            if let Some(rest) = path.strip_prefix("ref/") {
                return Route::Ref(percent_decode(rest));
            }
            if let Some(n) = path.strip_prefix("src/").and_then(|n| n.parse().ok()) {
                return Route::Src(n);
            }
            Route::NotFound
        }
    }
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-encodes everything but unreserved characters and `/`.
#[allow(dead_code)]
pub fn encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Parses a single `bytes=a-b` / `bytes=a-` / `bytes=-n` range against a body of `len` bytes.
/// Returns the inclusive `(start, end)`, or `None` when absent, unsupported or unsatisfiable.
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() {
            len - 1
        } else {
            b.parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "heic" | "heif" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "mov" => "video/quicktime",
        "mp4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "html" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// A response before it is turned into an `http::Response`.
#[derive(Debug)]
pub struct Payload {
    pub status: u16,
    pub mime: &'static str,
    pub body: Vec<u8>,
    /// `Content-Range` value for 206 responses.
    pub content_range: Option<String>,
}

impl Payload {
    pub fn status(status: u16) -> Self {
        Self {
            status,
            mime: "text/plain",
            body: Vec::new(),
            content_range: None,
        }
    }

    pub fn ok(mime: &'static str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            mime,
            body,
            content_range: None,
        }
    }
}

pub enum Source<'a> {
    Bytes(&'a [u8]),
    File(&'a Path),
}

/// Serves a whole body or the requested `Range` of it.
pub fn serve_source(source: Source, mime: &'static str, range: Option<&str>) -> Payload {
    let len = match &source {
        Source::Bytes(b) => b.len() as u64,
        Source::File(p) => match std::fs::metadata(p) {
            Ok(m) => m.len(),
            Err(_) => return Payload::status(404),
        },
    };
    let want = range.and_then(|r| parse_range(r, len));
    if want.is_none() && len > 0 && range.is_some_and(|r| r.trim().starts_with("bytes=") && !r.contains(','))
    {
        // A single range that cannot be satisfied.
        let mut p = Payload::status(416);
        p.content_range = Some(format!("bytes */{len}"));
        return p;
    }
    let (start, end) = want.unwrap_or((0, len.saturating_sub(1)));
    let size = if len == 0 { 0 } else { (end - start + 1) as usize };
    let body = match source {
        Source::Bytes(b) => b[start as usize..start as usize + size].to_vec(),
        Source::File(p) => {
            let read = || -> std::io::Result<Vec<u8>> {
                let mut f = std::fs::File::open(p)?;
                f.seek(SeekFrom::Start(start))?;
                let mut buf = vec![0u8; size];
                f.read_exact(&mut buf)?;
                Ok(buf)
            };
            match read() {
                Ok(b) => b,
                Err(_) => return Payload::status(404),
            }
        }
    };
    Payload {
        status: if want.is_some() { 206 } else { 200 },
        mime,
        body,
        content_range: want.map(|(s, e)| format!("bytes {s}-{e}/{len}")),
    }
}

fn asset_payload(asset: &Asset, range: Option<&str>) -> Payload {
    match asset {
        Asset::Bytes { data, ext } => serve_source(Source::Bytes(data), mime_for_ext(ext), range),
        Asset::File(path) => {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            serve_source(Source::File(path), mime_for_ext(ext), range)
        }
    }
}

/// Everything a request needs, cloned out of the session so no lock is held while serving.
pub struct Snapshot {
    pub report: Option<std::sync::Arc<ScanReport>>,
    pub prepared: Option<std::sync::Arc<photoway_core::media::Prepared>>,
    pub project: Option<std::sync::Arc<Project>>,
}

/// Content-Security-Policy of the preview document: MapLibre needs blob workers, and tiles
/// come from the online providers listed in `viewer/src/basemap.ts`.
pub const PREVIEW_CSP: &str = "default-src 'self' pw: http://pw.localhost; \
script-src 'self' pw: http://pw.localhost blob:; \
worker-src blob:; child-src blob:; \
style-src 'self' pw: http://pw.localhost 'unsafe-inline'; \
img-src 'self' pw: http://pw.localhost data: blob: https:; \
media-src 'self' pw: http://pw.localhost blob:; \
font-src 'self' data: https:; \
connect-src 'self' pw: http://pw.localhost blob: data: https:";

fn preview_html() -> &'static [u8] {
    static HTML: OnceLock<Vec<u8>> = OnceLock::new();
    HTML.get_or_init(|| {
        // The basemap sits inside a <script>: break any "</" so the JSON cannot close it.
        let basemap =
            String::from_utf8_lossy(assets::BASEMAP_JSON).replace("</", &format!("<{}/", char::from(92)));
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>Preview</title><link rel=\"stylesheet\" href=\"viewer.css\"></head><body>\
<script id=\"pw-basemap\" type=\"application/json\">{basemap}</script>\
<script src=\"viewer.js\"></script><script src=\"preview.js\"></script></body></html>"
        )
        .into_bytes()
    })
}

/// Mounts the real viewer in preview mode. Refs resolve to `ref/...` on this same origin.
const PREVIEW_JS: &str = "(function () {
  var handle = null;
  function load() {
    fetch('project.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('no project'); return r.json(); })
      .then(function (project) {
        if (handle) { handle.setProject(project); return; }
        var el = document.createElement('div');
        el.id = 'photoway';
        document.body.appendChild(el);
        handle = window.PhotoWay.mount(el, project, {
          mode: 'preview',
          resolveRef: function (ref) { return 'ref/' + encodeURI(ref); }
        });
      })
      .catch(function (e) { document.body.textContent = 'Preview unavailable: ' + e; });
  }
  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'pw-reload') load();
  });
  load();
})();
";

pub fn handle(path: &str, range: Option<&str>, snap: &Snapshot) -> Payload {
    match route(path) {
        Route::PreviewHtml => Payload::ok(mime_for_ext("html"), preview_html().to_vec()),
        Route::PreviewJs => Payload::ok(mime_for_ext("js"), PREVIEW_JS.as_bytes().to_vec()),
        Route::ViewerJs => Payload::ok(mime_for_ext("js"), assets::VIEWER_JS.to_vec()),
        Route::ViewerCss => Payload::ok(mime_for_ext("css"), assets::VIEWER_CSS.to_vec()),
        Route::ProjectJson => match &snap.project {
            Some(p) => match serde_json::to_vec(p.as_ref()) {
                Ok(b) => Payload::ok(mime_for_ext("json"), b),
                Err(_) => Payload::status(500),
            },
            None => Payload::status(404),
        },
        Route::Ref(rel) => match (&snap.prepared, &snap.project) {
            // Thumbnails are not `Asset`s, so `asset_for_ref` only covers full-size and video refs.
            (Some(prepared), Some(project)) => {
                if let Some(jpeg) = bundle::thumb_for_ref(prepared, project, &rel) {
                    serve_source(Source::Bytes(jpeg), mime_for_ext("jpg"), range)
                } else if let Some(asset) = bundle::asset_for_ref(prepared, project, &rel) {
                    asset_payload(asset, range)
                } else {
                    Payload::status(404)
                }
            }
            _ => Payload::status(404),
        },
        Route::Src(n) => match snap.report.as_ref().and_then(|r| r.entries.get(n)) {
            Some(entry) => serve_source(
                Source::File(&entry.path),
                mime_for_ext(entry.path.extension().and_then(|e| e.to_str()).unwrap_or("")),
                range,
            ),
            None => Payload::status(404),
        },
        Route::NotFound => Payload::status(404),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_known_paths() {
        assert_eq!(route("/"), Route::PreviewHtml);
        assert_eq!(route("/viewer.js"), Route::ViewerJs);
        assert_eq!(route("/project.json"), Route::ProjectJson);
        assert_eq!(
            route("/ref/thumbs/00001.jpg"),
            Route::Ref("thumbs/00001.jpg".into())
        );
        assert_eq!(
            route("/ref/media/0-a%20b.mov"),
            Route::Ref("media/0-a b.mov".into())
        );
        assert_eq!(route("/src/12"), Route::Src(12));
        assert_eq!(route("/src/x"), Route::NotFound);
        assert_eq!(route("/nope"), Route::NotFound);
    }

    #[test]
    fn refs_map_to_the_platform_scheme_url() {
        let url = ref_url("media/00001-a b.mov");
        assert!(url.ends_with("/ref/media/00001-a%20b.mov"), "{url}");
        if cfg!(windows) {
            assert!(url.starts_with("http://pw.localhost/"));
        } else {
            assert!(url.starts_with("pw://localhost/"));
        }
        // Whatever the shape, the path part routes back to the same ref.
        let path = url.split_once("localhost").unwrap().1;
        assert_eq!(route(path), Route::Ref("media/00001-a b.mov".into()));
    }

    #[test]
    fn percent_coding_round_trips_and_tolerates_garbage() {
        let s = format!("thumbs/{} 1%.jpg", char::from_u32(0x4e2d).unwrap());
        assert_eq!(percent_decode(&encode_path(&s)), s);
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn range_headers() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }

    #[test]
    fn serves_bytes_whole_partial_and_unsatisfiable() {
        let data = b"0123456789";
        let whole = serve_source(Source::Bytes(data), "video/mp4", None);
        assert_eq!((whole.status, whole.body.len()), (200, 10));
        let part = serve_source(Source::Bytes(data), "video/mp4", Some("bytes=2-4"));
        assert_eq!((part.status, part.body.as_slice()), (206, &b"234"[..]));
        assert_eq!(part.content_range.as_deref(), Some("bytes 2-4/10"));
        let bad = serve_source(Source::Bytes(data), "video/mp4", Some("bytes=50-"));
        assert_eq!(bad.status, 416);
    }

    #[test]
    fn serves_file_ranges_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.mov");
        std::fs::write(&p, b"abcdefghij").unwrap();
        let part = serve_source(Source::File(&p), "video/quicktime", Some("bytes=-3"));
        assert_eq!((part.status, part.body.as_slice()), (206, &b"hij"[..]));
        let missing = serve_source(Source::File(&dir.path().join("none")), "x", None);
        assert_eq!(missing.status, 404);
    }

    #[test]
    fn unknown_project_or_ref_is_404() {
        let snap = Snapshot {
            report: None,
            prepared: None,
            project: None,
        };
        assert_eq!(handle("/project.json", None, &snap).status, 404);
        assert_eq!(handle("/ref/thumbs/1.jpg", None, &snap).status, 404);
        assert_eq!(handle("/src/0", None, &snap).status, 404);
        assert_eq!(handle("/preview.js", None, &snap).status, 200);
    }

    #[test]
    fn serves_thumbnail_full_and_video_refs_of_the_project() {
        use photoway_core::media::{Prepared, Rendered};
        use std::sync::Arc;

        let project: Project = serde_json::from_value(serde_json::json!({
            "format": "photoway", "version": 1, "id": "p", "title": "t", "generator": "g",
            "createdAt": "2026-10-24T00:00:00Z",
            "options": { "theme": "auto", "basemap": "auto", "outlierSpeedKmh": 300.0 },
            "items": [{
                "id": 0, "kind": "video", "name": "a.mov", "time": null, "ts": null, "tsSource": null,
                "day": null, "lat": 1.0, "lon": 2.0, "w": 4, "h": 3,
                "thumb": "thumbs/00000.jpg", "full": "media/00000.jpg", "video": "media/00000.mov"
            }]
        }))
        .unwrap();
        let prepared = Prepared {
            rendered: vec![Rendered {
                thumb_jpeg: b"thumb".to_vec(),
                full: Some(Asset::Bytes {
                    data: b"full".to_vec(),
                    ext: "jpg",
                }),
                video: Some(Asset::Bytes {
                    data: b"video".to_vec(),
                    ext: "mov",
                }),
            }],
            ..Default::default()
        };
        let snap = Snapshot {
            report: None,
            prepared: Some(Arc::new(prepared)),
            project: Some(Arc::new(project)),
        };
        let thumb = handle("/ref/thumbs/00000.jpg", None, &snap);
        assert_eq!(
            (thumb.status, thumb.mime, thumb.body.as_slice()),
            (200, "image/jpeg", &b"thumb"[..])
        );
        assert_eq!(handle("/ref/media/00000.jpg", None, &snap).body, b"full");
        assert_eq!(handle("/ref/media/00000.mov", None, &snap).body, b"video");
        assert_eq!(handle("/ref/thumbs/00001.jpg", None, &snap).status, 404);
    }
}
