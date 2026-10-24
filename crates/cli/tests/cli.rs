//! End-to-end tests of the `photoway` binary: build all three formats, inspect, serve, errors.

#[path = "../../core/tests/common/mod.rs"]
mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Command, Stdio};

use common::{Gps, Mov, Shot, TempDir, write_jpeg, write_mov};

const BIN: &str = env!("CARGO_BIN_EXE_photoway");

/// Three geotagged JPEGs, one JPEG without GPS and one video.
fn photos() -> TempDir {
    let dir = TempDir::new("cli");
    for i in 0..3u32 {
        let shot = Shot {
            local: Some("2026:07:23 10:00:00"),
            offset: Some("+08:00"),
            gps: Some(Gps::at(30.123456 + f64::from(i) * 0.01, -120.654321)),
            ..Shot::new(320, 240)
        };
        write_jpeg(
            &dir.join(&format!("trip/IMG_{i:04}.jpg")),
            &shot,
            40 + i as u8 * 50,
        );
    }
    write_jpeg(&dir.join("trip/NOGPS.jpg"), &Shot::new(64, 64), 10);
    write_mov(
        &dir.join("trip/CLIP.mov"),
        &Mov {
            iso6709: Some("+30.5000-120.5000/"),
            created_unix: 1_784_800_000,
            w: 64,
            h: 48,
            rotated: false,
            millis: 1000,
            live_id: None,
        },
    );
    dir
}

fn run(args: &[&str]) -> (bool, String, String) {
    let out = Command::new(BIN).args(args).output().unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn path_str(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn builds_all_three_formats() {
    let src = photos();
    let input = src.path().join("trip");
    let out = TempDir::new("cli-out");
    let cases = [("html", "map.html"), ("dir", "map-dir"), ("zip", "map.zip")];
    for (format, name) in cases {
        let target = out.path().join(name);
        let (ok, stdout, stderr) = run(&[
            "build",
            path_str(&input),
            "-o",
            path_str(&target),
            "--format",
            format,
            "--title",
            "CLI trip",
            "--coord-decimals",
            "3",
        ]);
        assert!(ok, "{format}: {stderr}");
        assert!(
            stdout.contains("Items: 4 (3 photos, 1 videos, 0 live photos)"),
            "{stdout}"
        );
        assert!(stdout.contains("Skipped: 1"), "{stdout}");
        assert!(
            stdout.contains(&format!("Output: {}", target.display())),
            "{stdout}"
        );
        assert!(target.exists(), "{format}");
    }
    let html = std::fs::read_to_string(out.path().join("map.html")).unwrap();
    assert!(html.contains("<title>CLI trip</title>") && html.contains("#pack:thumbs:0:"));
    assert!(out.path().join("map-dir/index.html").is_file());
    assert!(out.path().join("map-dir/thumbs/00000.jpg").is_file());
    let data = std::fs::read_to_string(out.path().join("map-dir/data.js")).unwrap();
    assert!(
        data.contains("\"title\":\"CLI trip\"") && data.contains("30.123"),
        "{data}"
    );
    assert!(!data.contains("30.123456"), "coordinates are rounded");
    assert!(std::fs::metadata(out.path().join("map.zip")).unwrap().len() > 1000);
}

#[test]
fn build_options_are_applied() {
    let src = photos();
    let input = src.path().join("trip");
    let out = TempDir::new("cli-opts");
    let target = out.path().join("o");
    let (ok, _, stderr) = run(&[
        "build",
        path_str(&input),
        "-o",
        path_str(&target),
        "--format",
        "dir",
        "--full",
        "none",
        "--theme",
        "dark",
        "--basemap",
        "offline",
        "--cache",
        path_str(&out.path().join("cache")),
    ]);
    assert!(ok, "{stderr}");
    let data = std::fs::read_to_string(target.join("data.js")).unwrap();
    assert!(
        data.contains("\"theme\":\"dark\"") && data.contains("\"basemap\":\"offline\""),
        "{data}"
    );
    assert!(data.contains("\"full\":null"));
    assert!(out.path().join("cache").is_dir());
}

#[test]
fn inspect_prints_the_documented_json() {
    let src = photos();
    let input = src.path().join("trip");
    let (ok, stdout, stderr) = run(&["inspect", path_str(&input), "--json"]);
    assert!(ok, "{stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["entries"].as_array().unwrap().len(), 4);
    let first = &v["entries"][0];
    assert!(first["path"].is_string() && first["lat"].is_f64() && first["kind"].is_string());
    let skipped = v["skipped"].as_array().unwrap();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["reason"], "no-location");
    assert!(skipped[0]["path"].as_str().unwrap().ends_with("NOGPS.jpg"));

    let (ok, stdout, _) = run(&["inspect", path_str(&input)]);
    assert!(ok && stdout.contains("4 usable, 1 skipped"), "{stdout}");
}

#[test]
fn errors_are_one_line_on_stderr_with_a_nonzero_exit() {
    let out = TempDir::new("cli-err");
    let empty = out.join("empty/readme.txt");
    std::fs::write(&empty, "x").unwrap();
    let target = out.path().join("x.html");
    let (ok, stdout, stderr) = run(&[
        "build",
        path_str(empty.parent().unwrap()),
        "-o",
        path_str(&target),
    ]);
    assert!(!ok && stdout.is_empty());
    assert!(
        stderr.starts_with("error: ") && stderr.trim_end().lines().count() == 1,
        "{stderr}"
    );
    assert!(!target.exists());

    let (ok, _, stderr) = run(&[
        "build",
        path_str(out.path()),
        "-o",
        path_str(&target),
        "--theme",
        "neon",
    ]);
    assert!(!ok && stderr.starts_with("error: unknown theme"), "{stderr}");
    let (ok, _, stderr) = run(&["serve", path_str(&out.path().join("missing"))]);
    assert!(!ok && stderr.starts_with("error: "), "{stderr}");
}

#[test]
fn serve_announces_itself_first_and_answers_requests() {
    let src = photos();
    let out = TempDir::new("cli-serve");
    let site = out.path().join("site");
    let (ok, _, stderr) = run(&[
        "build",
        path_str(&src.path().join("trip")),
        "-o",
        path_str(&site),
        "--format",
        "dir",
    ]);
    assert!(ok, "{stderr}");

    let mut child = Command::new(BIN)
        .args(["serve", path_str(&site), "--addr", "127.0.0.1:0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut first = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut first)
        .unwrap();
    let result = std::panic::catch_unwind(|| {
        let prefix = format!("Serving {} at http://127.0.0.1:", site.display());
        assert!(first.starts_with(&prefix), "{first}");
        let url = first.trim_end().rsplit(" at ").next().unwrap();
        let hostport = url.trim_start_matches("http://").trim_end_matches('/');
        assert!(!hostport.ends_with(":0"), "port 0 must be resolved: {first}");
        let mut s = TcpStream::connect(hostport).unwrap();
        s.write_all(b"GET /data.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut body = String::new();
        s.read_to_string(&mut body).unwrap();
        assert!(
            body.starts_with("HTTP/1.1 200") && body.contains("window.__PHOTOWAY__"),
            "{body}"
        );
    });
    let _ = child.kill();
    let _ = child.wait();
    result.unwrap();
}
