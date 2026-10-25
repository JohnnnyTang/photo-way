# Changelog

All notable changes to Photo Way are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Release notes on GitHub are extracted from the section for the tag.

## [Unreleased]

## [0.2.0] - 2026-10-24

### English

- Add English and Simplified Chinese controls to the desktop app and exported viewer. The app remembers its language and offers an independent export language; the viewer remembers a choice for each trip.
- Include both languages in HTML, folder, and ZIP exports. Language switching works offline, and Save a copy embeds the selected language alongside edits.
- Add `photoway build --lang en|zh-CN`, bilingual README and user guides, a multilingual Windows setup, and separate English and Simplified Chinese MSI installers.
- Keep older project files and settings compatible. Existing exported files retain their embedded viewer; create a new export for bilingual controls.

### 简体中文

- 桌面应用和导出地图新增英语、简体中文界面。应用会记住界面语言，导出语言可单独选择；地图会按旅程保存语言选择。
- HTML、文件夹和 ZIP 导出均包含双语界面。离线时仍可切换语言；“保存副本”会同时保留所选语言和编辑内容。
- 命令行新增 `photoway build --lang en|zh-CN`，并提供中英文自述文件与使用指南。Windows 提供双语安装程序及英文、简体中文 MSI 安装包。
- 兼容旧项目和设置。已导出的旧文件仍使用原有地图界面；重新导出后即可使用双语功能。

## [0.1.1] - 2026-10-24

### Added
- Distance, climb and descent, and time for each day in the day list, and for the whole trip (or the chosen
  day) in the line under the title. They update as you hide items, fix positions or switch the GPS outlier
  filter.
- User guide: installing the unsigned app, getting originals with their location off iPhone and Android,
  using the app and the map, privacy before sharing, the command line, troubleshooting. A rewritten README
  with screenshots.

### Fixed
- Installer files are named without spaces (`Photo-Way_...`), so `SHA256SUMS.txt` matches the downloaded
  files. GitHub had renamed `Photo Way_...` to `Photo.Way_...` on upload.

### Project
- Release smoke test on clean Windows, macOS arm64 and macOS Intel runners: checksums, install, launch and
  uninstall, universal binaries, version numbers, and the command line tool, run against every published
  release. A release checklist in `docs/RELEASING.md`.

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
