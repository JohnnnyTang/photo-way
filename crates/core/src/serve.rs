//! Local static server for a folder, zip, or single HTML. Owner: Wave 2 · E.
//!
//! Signatures here are frozen for Wave 2 (the app and the E2E suite build against them).
//!
//! Folders are streamed from disk, zip entries are read in place (nothing is extracted) and a
//! single `.html` is served at `/`. Only `GET` and `HEAD` are accepted, `Range` requests work
//! (video seeking), and paths with `..`, backslashes, drive letters or NUL bytes are refused.

use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::{Error, Result};

const WORKERS: usize = 4;
const POLL: Duration = Duration::from_millis(100);

/// A running server. Dropping it stops the server.
pub struct ServerHandle {
    /// The bound address (the real port when the requested port was 0).
    pub addr: SocketAddr,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl ServerHandle {
    /// `http://<addr>/`, the URL that opens the map.
    pub fn url(&self) -> String {
        format!("http://{}/", self.addr)
    }

    /// Stops the server and waits for its threads.
    pub fn stop(self) {}

    /// Blocks until the server stops (the CLI's `serve` runs until Ctrl+C).
    pub fn wait(mut self) {
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

enum Content {
    Dir(PathBuf),
    /// `prefix` is the folder inside the archive that holds `index.html` ("" or "name/").
    Zip {
        archive: Mutex<zip::ZipArchive<File>>,
        prefix: String,
    },
    Html(PathBuf),
}

/// Starts serving in background threads and returns once the socket is bound.
/// `path` is a bundle directory, a `.zip` bundle (served without extracting), or a single `.html`.
pub fn serve(path: &Path, addr: SocketAddr) -> Result<ServerHandle> {
    let content = open_content(path)?;
    let server =
        Server::http(addr).map_err(|e| Error::Other(anyhow::anyhow!("cannot listen on {addr}: {e}")))?;
    let bound = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| Error::Other(anyhow::anyhow!("server is not bound to an IP address")))?;
    let (server, content, stop) = (
        Arc::new(server),
        Arc::new(content),
        Arc::new(AtomicBool::new(false)),
    );
    let threads = (0..WORKERS)
        .map(|_| {
            let (server, content, stop) = (server.clone(), content.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match server.recv_timeout(POLL) {
                        Ok(Some(request)) => handle(&content, request),
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
            })
        })
        .collect();
    Ok(ServerHandle {
        addr: bound,
        stop,
        threads,
    })
}

fn open_content(path: &Path) -> Result<Content> {
    let missing = |what: &str| Error::Other(anyhow::anyhow!("{what}: {}", path.display()));
    if path.is_dir() {
        if !path.join("index.html").is_file() {
            return Err(missing("no index.html in folder"));
        }
        return Ok(Content::Dir(path.canonicalize()?));
    }
    if !path.is_file() {
        return Err(missing("no such file or folder"));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => Ok(Content::Html(path.to_path_buf())),
        "zip" => {
            let archive = zip::ZipArchive::new(File::open(path)?)
                .map_err(|e| Error::Other(anyhow::anyhow!("cannot read zip {}: {e}", path.display())))?;
            let names: Vec<String> = archive
                .file_names()
                .filter_map(|n| n.ok())
                .map(Cow::into_owned)
                .collect();
            let prefix = if names.iter().any(|n| n == "index.html") {
                String::new()
            } else {
                // A re-zipped folder: `name/index.html`.
                let mut tops = names
                    .iter()
                    .filter_map(|n| n.strip_suffix("/index.html"))
                    .filter(|d| !d.contains('/'));
                match (tops.next(), tops.next()) {
                    (Some(d), None) => format!("{d}/"),
                    _ => return Err(missing("no index.html in zip")),
                }
            };
            Ok(Content::Zip {
                archive: Mutex::new(archive),
                prefix,
            })
        }
        _ => Err(missing("expected a folder, a .zip or an .html file")),
    }
}

fn mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Decodes `%XX` escapes; `None` for malformed or non-UTF-8 input.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A request URL as safe path segments (`""` = the root), or `None` when it must be refused.
fn safe_segments(url: &str) -> Option<Vec<String>> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(path)?;
    if decoded.contains(['\0', char::from(92u8), ':']) || !decoded.starts_with('/') {
        return None;
    }
    let mut out = Vec::new();
    for seg in decoded[1..].split('/') {
        match seg {
            ".." => return None,
            "" | "." => {}
            s => out.push(s.to_string()),
        }
    }
    Some(out)
}

/// A body ready to send: whole or a window of it.
struct Body {
    reader: Box<dyn Read + Send>,
    len: u64,
    total: u64,
    /// `Some((start, end))` when answering a range request.
    range: Option<(u64, u64)>,
}

/// Parses a single `bytes=a-b` range against `total`. `Err(())` = unsatisfiable.
fn parse_range(header: &str, total: u64) -> Option<std::result::Result<(u64, u64), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let range = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (n > 0 && total > 0).then(|| (total.saturating_sub(n), total - 1))
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() {
            total.saturating_sub(1)
        } else {
            b.parse::<u64>().ok()?.min(total.saturating_sub(1))
        };
        (start < total && start <= end).then_some((start, end))
    };
    Some(range.ok_or(()))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn plain(status: u16, text: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(text)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "text/plain; charset=utf-8"))
}

fn handle(content: &Content, request: Request) {
    let head = *request.method() == Method::Head;
    if !matches!(request.method(), Method::Get | Method::Head) {
        let _ = request.respond(plain(405, "method not allowed").with_header(header("Allow", "GET, HEAD")));
        return;
    }
    let Some(segs) = safe_segments(request.url()) else {
        let _ = request.respond(plain(400, "bad path"));
        return;
    };
    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());
    let Some((name, body)) = lookup(content, &segs, range_header.as_deref()) else {
        let _ = request.respond(plain(404, "not found"));
        return;
    };
    let body = match body {
        Ok(b) => b,
        Err(total) => {
            let r = plain(416, "range not satisfiable")
                .with_header(header("Content-Range", &format!("bytes */{total}")));
            let _ = request.respond(r);
            return;
        }
    };
    let status = if body.range.is_some() { 206 } else { 200 };
    let mut response = Response::new(
        StatusCode(status),
        vec![
            header("Content-Type", mime(&name)),
            header("Accept-Ranges", "bytes"),
            header("Cache-Control", "no-cache"),
            header("X-Content-Type-Options", "nosniff"),
        ],
        if head {
            Box::new(std::io::empty()) as Box<dyn Read + Send>
        } else {
            body.reader
        },
        Some(if head { 0 } else { body.len as usize }),
        None,
    );
    if let Some((s, e)) = body.range {
        response.add_header(header("Content-Range", &format!("bytes {s}-{e}/{}", body.total)));
    }
    let _ = request.respond(response);
}

/// Resolves the request to `(file name, body)`. The body is `Err(total)` for an unsatisfiable range.
fn lookup(
    content: &Content,
    segs: &[String],
    range: Option<&str>,
) -> Option<(String, std::result::Result<Body, u64>)> {
    match content {
        Content::Html(file) => {
            let ok = segs.is_empty() || (segs.len() == 1 && segs[0] == "index.html");
            if !ok {
                return None;
            }
            let data = std::fs::read(file).ok()?;
            Some(("index.html".into(), window(data, range)))
        }
        Content::Dir(root) => {
            let mut path = root.clone();
            path.extend(segs);
            if path.is_dir() {
                path.push("index.html");
            }
            // Resolve symlinks and re-check, so links cannot lead out of the folder.
            let path = path.canonicalize().ok()?;
            if !path.starts_with(root) || !path.is_file() {
                return None;
            }
            let mut file = File::open(&path).ok()?;
            let total = file.metadata().ok()?.len();
            let name = path.file_name()?.to_string_lossy().into_owned();
            let body = match range.and_then(|h| parse_range(h, total)) {
                None => Ok(Body {
                    reader: Box::new(file),
                    len: total,
                    total,
                    range: None,
                }),
                Some(Err(())) => Err(total),
                Some(Ok((s, e))) => {
                    file.seek(SeekFrom::Start(s)).ok()?;
                    Ok(Body {
                        reader: Box::new(file.take(e - s + 1)),
                        len: e - s + 1,
                        total,
                        range: Some((s, e)),
                    })
                }
            };
            Some((name, body))
        }
        Content::Zip { archive, prefix } => {
            let rel = if segs.is_empty() {
                "index.html".to_string()
            } else {
                segs.join("/")
            };
            let entry = format!("{prefix}{rel}");
            let mut archive = archive.lock().ok()?;
            let mut data = Vec::new();
            {
                let mut f = archive.by_name(&entry).ok().filter(|f| f.is_file());
                f.as_mut()?.read_to_end(&mut data).ok()?;
            }
            Some((rel, window(data, range)))
        }
    }
}

fn window(data: Vec<u8>, range: Option<&str>) -> std::result::Result<Body, u64> {
    let total = data.len() as u64;
    match range.and_then(|h| parse_range(h, total)) {
        None => Ok(Body {
            reader: Box::new(std::io::Cursor::new(data)),
            len: total,
            total,
            range: None,
        }),
        Some(Err(())) => Err(total),
        Some(Ok((s, e))) => Ok(Body {
            reader: Box::new(std::io::Cursor::new(data[s as usize..=e as usize].to_vec())),
            len: e - s + 1,
            total,
            range: Some((s, e)),
        }),
    }
}
