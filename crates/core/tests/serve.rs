//! Tests for `photoway_core::serve`, over real sockets with a minimal HTTP/1.1 client.

mod common;
mod export_support;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use export_support::{Fixture, fixture};
use photoway_core::bundle::{self, Format};
use photoway_core::media::FullSize;
use photoway_core::{NoProgress, serve};

struct Reply {
    status: u16,
    headers: String,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<String> {
        self.headers.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }
}

/// Sends `target` verbatim (so `..` segments are not normalised by a client library).
fn request(addr: SocketAddr, method: &str, target: &str, extra: &[(&str, &str)]) -> Reply {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let cr = char::from(13u8);
    let lf = char::from(10u8);
    let mut req =
        format!("{method} {target} HTTP/1.1{cr}{lf}Host: localhost{cr}{lf}Connection: close{cr}{lf}");
    for (k, v) in extra {
        req.push_str(&format!("{k}: {v}{cr}{lf}"));
    }
    req.push_str(&format!("{cr}{lf}"));
    s.write_all(req.as_bytes()).unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let split = raw
        .windows(4)
        .position(|w| w == [13, 10, 13, 10])
        .expect("header end");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let (status_line, headers) = head.split_once(char::from(10u8)).unwrap_or((&head, ""));
    let mut reply = Reply {
        status: status_line.split(' ').nth(1).unwrap().parse().unwrap(),
        headers: headers.to_string(),
        body: raw[split + 4..].to_vec(),
    };
    if reply.header("transfer-encoding").is_some_and(|v| v == "chunked") {
        reply.body = dechunk(&reply.body);
    }
    reply
}

fn dechunk(mut rest: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let eol = rest
            .windows(2)
            .position(|w| w == [13, 10])
            .expect("chunk size line");
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..eol]).unwrap().trim(), 16).unwrap();
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&rest[eol + 2..eol + 2 + size]);
        rest = &rest[eol + 2 + size + 2..];
    }
}

fn get(addr: SocketAddr, target: &str) -> Reply {
    request(addr, "GET", target, &[])
}

fn any_port() -> SocketAddr {
    "127.0.0.1:0".parse().unwrap()
}

fn export(f: &Fixture, format: Format, name: &str) -> std::path::PathBuf {
    let out = f.dir.path().join(name);
    bundle::write(&f.prepared, &f.project, format, &out, &f.opts, &NoProgress).unwrap();
    out
}

/// What every bundle server (dir and zip) must answer the same way.
fn check_bundle(addr: SocketAddr, f: &Fixture) {
    let index = get(addr, "/");
    assert_eq!(index.status, 200);
    assert!(index.header("content-type").unwrap().starts_with("text/html"));
    assert!(String::from_utf8_lossy(&index.body).contains("<script src=\"data.js\">"));

    let js = get(addr, "/assets/viewer.js");
    assert_eq!(js.status, 200);
    assert!(js.header("content-type").unwrap().starts_with("text/javascript"));
    assert_eq!(
        get(addr, "/assets/viewer.css").header("content-type").unwrap(),
        "text/css; charset=utf-8"
    );

    let thumb = get(addr, &format!("/{}", f.project.items[0].thumb));
    assert_eq!(
        (thumb.status, thumb.header("content-type").unwrap().as_str()),
        (200, "image/jpeg")
    );
    assert_eq!(thumb.body, f.prepared.rendered[0].thumb_jpeg);
    let query = get(addr, &format!("/{}?v=1", f.project.items[0].thumb));
    assert_eq!(query.body, thumb.body);

    let video = f.project.items.iter().find_map(|i| i.video.clone()).unwrap();
    assert_eq!(
        get(addr, &format!("/{video}")).header("content-type").unwrap(),
        "video/quicktime"
    );

    assert_eq!(get(addr, "/nope.html").status, 404);
    assert_eq!(get(addr, "/thumbs/").status, 404);
    for bad in [
        "/../Cargo.toml",
        "/assets/../../Cargo.toml",
        "/%2e%2e/Cargo.toml",
        "/%2E%2E%2FCargo.toml",
        "/assets%5C..%5C..%5Cx",
        "/C:/Windows/win.ini",
        "//etc/passwd",
        "/%00",
    ] {
        let r = get(addr, bad);
        assert!(matches!(r.status, 400 | 404), "{bad} -> {}", r.status);
        assert!(!String::from_utf8_lossy(&r.body).contains("[workspace]"));
    }
    assert_eq!(request(addr, "POST", "/", &[]).status, 405);

    let head = request(addr, "HEAD", "/", &[]);
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());

    let part = request(addr, "GET", &format!("/{video}"), &[("Range", "bytes=2-9")]);
    assert_eq!(part.status, 206);
    assert_eq!(part.body.len(), 8);
    assert!(part.header("content-range").unwrap().starts_with("bytes 2-9/"));
    assert_eq!(
        request(
            addr,
            "GET",
            &format!("/{video}"),
            &[("Range", "bytes=999999999-")]
        )
        .status,
        416
    );
}

#[test]
fn serves_a_directory() {
    let f = fixture(2, FullSize::Web);
    let out = export(&f, Format::Dir, "site");
    let h = serve::serve(&out, any_port()).unwrap();
    assert_ne!(h.addr.port(), 0);
    assert_eq!(h.url(), format!("http://{}/", h.addr));
    check_bundle(h.addr, &f);
    h.stop();
}

#[test]
fn serves_a_zip_without_extracting() {
    let f = fixture(2, FullSize::Web);
    let out = export(&f, Format::Zip, "trip.zip");
    let h = serve::serve(&out, any_port()).unwrap();
    check_bundle(h.addr, &f);
    assert!(!f.dir.path().join("trip").exists());
    h.stop();
}

#[test]
fn serves_a_zip_made_from_a_folder_with_a_top_level_directory() {
    let f = fixture(1, FullSize::None);
    let dir = export(&f, Format::Dir, "site");
    let zip_path = f.dir.path().join("wrapped.zip");
    let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
    let opts = zip::write::SimpleFileOptions::default();
    for name in ["index.html", "data.js"] {
        w.start_file(format!("site/{name}"), opts).unwrap();
        w.write_all(&std::fs::read(dir.join(name)).unwrap()).unwrap();
    }
    w.finish().unwrap();
    let h = serve::serve(&zip_path, any_port()).unwrap();
    let r = get(h.addr, "/data.js");
    assert_eq!(r.status, 200);
    assert!(r.body.starts_with(b"window.__PHOTOWAY__"));
}

#[test]
fn serves_a_single_html_at_the_root() {
    let f = fixture(2, FullSize::Web);
    let out = export(&f, Format::Html, "page.html");
    let h = serve::serve(&out, any_port()).unwrap();
    let r = get(h.addr, "/");
    assert_eq!(r.status, 200);
    assert!(r.header("content-type").unwrap().starts_with("text/html"));
    assert_eq!(r.body, std::fs::read(&out).unwrap());
    assert_eq!(get(h.addr, "/index.html").status, 200);
    assert_eq!(get(h.addr, "/other").status, 404);
    assert_eq!(get(h.addr, "/../page.html").status, 400);
}

#[test]
fn stop_and_drop_release_the_port() {
    let f = fixture(1, FullSize::None);
    let out = export(&f, Format::Html, "page.html");
    let h = serve::serve(&out, any_port()).unwrap();
    let addr = h.addr;
    assert_eq!(get(addr, "/").status, 200);
    h.stop();
    assert!(port_closes(addr));

    let h = serve::serve(&out, any_port()).unwrap();
    let addr = h.addr;
    drop(h);
    assert!(port_closes(addr));
}

#[test]
fn wait_blocks_until_the_server_is_stopped() {
    let f = fixture(1, FullSize::None);
    let out = export(&f, Format::Html, "page.html");
    let h = serve::serve(&out, any_port()).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        h.wait();
        let _ = tx.send(());
    });
    assert!(
        rx.recv_timeout(Duration::from_millis(500)).is_err(),
        "wait returned early"
    );
}

#[test]
fn bad_inputs_are_errors() {
    let f = fixture(1, FullSize::None);
    assert!(serve::serve(&f.dir.path().join("missing"), any_port()).is_err());
    assert!(
        serve::serve(f.dir.path(), any_port()).is_err(),
        "folder without index.html"
    );
    let txt = f.dir.join("a.txt");
    std::fs::write(&txt, "x").unwrap();
    assert!(serve::serve(&txt, any_port()).is_err());
    let out = export(&f, Format::Html, "page.html");
    let first = serve::serve(&out, any_port()).unwrap();
    assert!(serve::serve(&out, first.addr).is_err(), "port in use");
}

/// Reads one response off a keep-alive connection, framed by its Content-Length.
fn read_framed(s: &mut TcpStream) -> (u16, Vec<u8>) {
    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    while !raw.ends_with(&[13, 10, 13, 10]) {
        assert_eq!(s.read(&mut byte).unwrap(), 1, "connection closed mid-head");
        raw.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&raw).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let len: usize = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse().unwrap())
        })
        .expect("content-length");
    let mut body = vec![0; len];
    s.read_exact(&mut body).unwrap();
    (status, body)
}

/// A browser keeps several keep-alive connections open; a request on any of them, or on a new
/// one, must still be answered. (tiny_http's worker pool could leave one waiting indefinitely.)
#[test]
fn many_open_keep_alive_connections_are_all_answered() {
    let f = fixture(1, FullSize::None);
    let out = export(&f, Format::Dir, "site");
    let (cr, lf) = (char::from(13u8), char::from(10u8));
    let req = |target: &str| format!("GET {target} HTTP/1.1{cr}{lf}Host: localhost{cr}{lf}{cr}{lf}");
    let thumb = format!("/{}", f.project.items[0].thumb);
    for _ in 0..10 {
        let h = serve::serve(&out, any_port()).unwrap();
        let idle: Vec<TcpStream> = (0..8).map(|_| TcpStream::connect(h.addr).unwrap()).collect();
        let mut conns: Vec<TcpStream> = (0..12).map(|_| TcpStream::connect(h.addr).unwrap()).collect();
        for s in &mut conns {
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            s.write_all(req(&thumb).as_bytes()).unwrap();
        }
        for s in &mut conns {
            assert_eq!(read_framed(s), (200, f.prepared.rendered[0].thumb_jpeg.clone()));
        }
        // The same connections serve a second request each (keep-alive).
        for s in &mut conns {
            s.write_all(req("/data.js").as_bytes()).unwrap();
            let (status, body) = read_framed(s);
            assert_eq!(status, 200);
            assert!(body.starts_with(b"window.__PHOTOWAY__"));
        }
        drop(idle);
        h.stop();
    }
}

#[test]
fn head_reports_the_length_without_a_body() {
    let f = fixture(1, FullSize::None);
    let out = export(&f, Format::Html, "page.html");
    let h = serve::serve(&out, any_port()).unwrap();
    let r = request(h.addr, "HEAD", "/", &[]);
    assert_eq!(r.status, 200);
    assert!(r.body.is_empty());
    let len = std::fs::metadata(&out).unwrap().len().to_string();
    assert_eq!(r.header("content-length").as_deref(), Some(len.as_str()));
}

/// The listener closes on the accept thread, which `stop()`/drop join, but connecting can still
/// race the OS releasing the socket, so this polls briefly.
fn port_closes(addr: SocketAddr) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}
