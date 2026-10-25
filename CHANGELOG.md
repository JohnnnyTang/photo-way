# Changelog

All notable changes to Photo Way are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Release notes on GitHub are extracted from the section for the tag.

## [Unreleased]

### English

- Prepare bilingual documentation and Windows installer language options for the next release.

### 简体中文

- 为下一版本准备中英文文档及 Windows 安装程序的语言选项。

## [0.1.0] - 2026-10-24

First release: a small desktop app for Windows and macOS that turns geotagged photos and videos into a
route map you can share as one HTML file, a folder, or a zip.

### Added
- Desktop app: drop folders or files (JPEG, HEIC/HEIF, PNG, TIFF, DNG, MOV, MP4), see what was found and
  what was skipped (no location, unreadable), pick options, preview the real map live, then export.
- Exports open in any modern browser straight from disk, with no server or install: a single HTML file
  (thumbnails inside), a folder, or a zip ("unzip, then double-click index.html"). Size estimate before
  exporting, with a warning above 50 MB for single files.
- Privacy options: strip EXIF metadata, round coordinates, thumbnails only, web-size or original photos.
- Map: clustered photo pins, route with direction arrows, day-to-day links, start and end, offline world
  map plus satellite, satellite with labels, topographic, street and 3D terrain basemaps, globe view,
  themes (auto, light, dark, dusk, paper, forest).
- Trip order, each a switch under Filters: colour the route by time with a legend, number the stops,
  highlight a photo's part of the route on hover (other days stay faint around a chosen day), and play
  the trip stop by stop at 1x to 8x.
- Timeline with day navigation, photo and video viewer with keyboard navigation, GPS outlier filter,
  drag a pin to fix its position, hide items, export corrections, and "Save a copy" with edits built in.
- Video posters from the video itself, Live Photo pairing, duplicate detection, cached processing so
  re-exports are fast.
- Open the export in a browser, reveal it in Explorer or Finder, or serve it locally from the app.
- `photoway` command line tool: `build`, `serve` (a folder, a zip without extracting, or a single HTML)
  and `inspect`.
- Works on phone browsers too.

### Known limitations
- The installers are not code-signed. Windows SmartScreen may warn ("More info", then "Run anyway");
  on macOS, right-click the app and choose Open the first time.
- The macOS app has passed CI and automated tests, but the full flow has only been checked by hand on
  Windows so far.

### Project
- CI on Windows, macOS and Ubuntu: Rust checks and tests, viewer unit and end-to-end tests in Chromium,
  Firefox and WebKit against real exports, a 5,000-photo performance check, and size budgets.
- Release workflow: Windows NSIS and MSI installers, macOS universal dmg, CLI archives, SHA-256
  checksums, and the LGPL corresponding source for libheif and libde265 (HEIC decoding, linked
  statically).
