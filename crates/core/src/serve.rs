//! Local static server for a folder, zip, or single HTML. Owner: Wave 2 · E.
//!
//! Signatures here are frozen for Wave 2 (the app and the E2E suite build against them).
//!
//! Folders are streamed from disk, zip entries are read in place (nothing is extracted) and a
//! single `.html` is served at `/`. Only `GET` and `HEAD` are accepted, `Range` requests work
//! (video seeking), and paths with `..`, backslashes, drive letters or NUL bytes are refused.
//!
//! A small HTTP/1.1 server with one thread per connection and keep-alive. Browsers hold several
//! idle keep-alive connections open, so a shared worker pool could leave a new connection's
//! request waiting behind them (tiny_http's pool did, and thumbnails never loaded).

use std::borrow::Cow;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::{Error, Result};

/// How often the accept loop looks for new connections and the stop flag.
const ACCEPT_POLL: Duration = Duration::from_millis(20);
/// How often an idle connection looks at the stop flag.
const READ_POLL: Duration = Duration::from_millis(250);
/// An idle keep-alive connection (or a request head that never completes) is closed after this.
const IDLE: Duration = Duration::from_secs(30);
/// A client that stops reading a response is dropped after this.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HEAD: usize = 16 * 1024;
const CRLF: [u8; 2] = [13, 10];
const LF: u8 = 10;

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
    let content = Arc::new(open_content(path)?);
    let listen_err = |e: io::Error| Error::Other(anyhow::anyhow!("cannot listen on {addr}: {e}"));
    let listener = TcpListener::bind(addr).map_err(listen_err)?;
    let bound = listener.local_addr().map_err(listen_err)?;
    // Non-blocking so the accept loop can notice `stop`; the listener closes when the loop ends.
    listener.set_nonblocking(true).map_err(listen_err)?;
    let stop = Arc::new(AtomicBool::new(false));
    let accept = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let (content, stop) = (content.clone(), stop.clone());
                        std::thread::spawn(move || connection(&content, stream, &stop));
                    }
                    // Nothing pending, or a transient failure such as running out of handles.
                    Err(_) => std::thread::sleep(ACCEPT_POLL),
                }
            }
        })
    };
    Ok(ServerHandle {
        addr: bound,
        stop,
        threads: vec![accept],
    })
}

/// Serves requests on one connection until the peer closes it, it idles, or the server stops.
fn connection(content: &Content, stream: TcpStream, stop: &AtomicBool) {
    // Accepted sockets inherit the listener's non-blocking mode on some platforms.
    if stream.set_nonblocking(false).is_err()
        || stream.set_read_timeout(Some(READ_POLL)).is_err()
        || stream.set_write_timeout(Some(WRITE_TIMEOUT)).is_err()
    {
        return;
    }
    let _ = stream.set_nodelay(true);
    let mut reader = BufReader::new(stream);
    while let Ok(Some(head)) = read_head(&mut reader, stop) {
        let Some(request) = parse_head(&head) else {
            let _ = write_reply(reader.get_ref(), plain(400, "bad request"), false, false);
            return;
        };
        let reply = respond(content, &request);
        let head_only = request.method == "HEAD";
        if write_reply(reader.get_ref(), reply, head_only, request.keep_alive).is_err() || !request.keep_alive
        {
            return;
        }
    }
}

/// Reads one request head, through its blank line. `None` when the peer closed the connection,
/// it stayed idle for `IDLE`, or the server is stopping.
fn read_head(reader: &mut BufReader<TcpStream>, stop: &AtomicBool) -> io::Result<Option<Vec<u8>>> {
    let started = Instant::now();
    let mut head = Vec::new();
    let mut line_start = 0;
    loop {
        if stop.load(Ordering::SeqCst) || started.elapsed() > IDLE {
            return Ok(None);
        }
        // On a timeout the bytes read so far stay in `head` and the next call continues the line.
        match reader.read_until(LF, &mut head) {
            Ok(0) => return Ok(None),
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(e) => return Err(e),
        }
        if head.last() != Some(&LF) {
            continue; // the peer closed mid-line; the next read returns 0
        }
        let line = &head[line_start..];
        if line == CRLF || line == [LF] {
            if line_start == 0 {
                head.clear(); // a stray blank line between requests
                continue;
            }
            return Ok(Some(head));
        }
        if head.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
        line_start = head.len();
    }
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    keep_alive: bool,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn parse_head(head: &[u8]) -> Option<Request> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.lines();
    let mut parts = lines.next()?.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return None;
    }
    let headers = lines
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.trim().to_string(), v.trim().to_string()))
        })
        .collect::<Option<Vec<_>>>()?;
    let mut request = Request {
        method: method.to_string(),
        target: target.to_string(),
        headers,
        keep_alive: false,
    };
    let connection = request.header("Connection").unwrap_or("").to_ascii_lowercase();
    // Request bodies are never read, so a connection that sent one cannot be reused.
    let has_body = request.header("Content-Length").is_some_and(|v| v != "0")
        || request.header("Transfer-Encoding").is_some();
    request.keep_alive = !has_body
        && if version == "HTTP/1.1" {
            !connection.contains("close")
        } else {
            connection.contains("keep-alive")
        };
    Some(request)
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

/// A response ready to write: status, headers (without the framing ones) and a body of `len` bytes.
struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Box<dyn Read + Send>,
    len: u64,
}

fn plain(status: u16, text: &str) -> Reply {
    Reply {
        status,
        headers: vec![("Content-Type", "text/plain; charset=utf-8".into())],
        len: text.len() as u64,
        body: Box::new(io::Cursor::new(text.as_bytes().to_vec())),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "",
    }
}

fn respond(content: &Content, request: &Request) -> Reply {
    if !matches!(request.method.as_str(), "GET" | "HEAD") {
        let mut r = plain(405, "method not allowed");
        r.headers.push(("Allow", "GET, HEAD".into()));
        return r;
    }
    let Some(segs) = safe_segments(&request.target) else {
        return plain(400, "bad path");
    };
    let Some((name, body)) = lookup(content, &segs, request.header("Range")) else {
        return plain(404, "not found");
    };
    let body = match body {
        Ok(b) => b,
        Err(total) => {
            let mut r = plain(416, "range not satisfiable");
            r.headers.push(("Content-Range", format!("bytes */{total}")));
            return r;
        }
    };
    let mut headers = vec![
        ("Content-Type", mime(&name).to_string()),
        ("Accept-Ranges", "bytes".to_string()),
        ("Cache-Control", "no-cache".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
    ];
    if let Some((s, e)) = body.range {
        headers.push(("Content-Range", format!("bytes {s}-{e}/{}", body.total)));
    }
    Reply {
        status: if body.range.is_some() { 206 } else { 200 },
        headers,
        body: body.reader,
        len: body.len,
    }
}

/// Writes `reply`; HEAD gets the same headers (including Content-Length) and no body.
fn write_reply(mut out: &TcpStream, reply: Reply, head_only: bool, keep_alive: bool) -> io::Result<()> {
    let mut head = Vec::with_capacity(256);
    let mut line = |s: &str| {
        head.extend_from_slice(s.as_bytes());
        head.extend_from_slice(&CRLF);
    };
    line(&format!("HTTP/1.1 {} {}", reply.status, reason(reply.status)));
    for (k, v) in &reply.headers {
        line(&format!("{k}: {v}"));
    }
    line(&format!("Content-Length: {}", reply.len));
    line(if keep_alive {
        "Connection: keep-alive"
    } else {
        "Connection: close"
    });
    line("");
    out.write_all(&head)?;
    if !head_only {
        let sent = io::copy(&mut reply.body.take(reply.len), &mut out)?;
        if sent < reply.len {
            // The file shrank under us; the promised length cannot be met, so drop the connection.
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "body ended early"));
        }
    }
    out.flush()
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
