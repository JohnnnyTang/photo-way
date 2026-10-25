# Photo Way

[简体中文](README.zh-CN.md) · [English user guide](docs/USER_GUIDE.md) · [中文使用指南](docs/USER_GUIDE.zh-CN.md)

Turn a pile of geotagged phone photos into a **portable route map** — one `.html` file
(or a small zip) that opens by double-click, works offline, and can be shared without the app.

> **v0.1.0 is released.** English + Simplified Chinese support is being developed for **v0.2.0**. See the [Wave 4 plan](docs/WAVE4_PLAN.md) and [development roadmap](docs/PLAN.md).

## What it does

- Drop photos/videos from your iPhone or Android phone (HEIC, JPEG, MOV, MP4…).
- See your trip as a route on a map: timeline, days, Live Photos, GPS-glitch filtering.
- Export a single self-contained HTML file, or a folder/zip bundle with full-size photos.
- The exported map works from `file://` and from any web server; themes, offline basemap,
  satellite / topo / **3D terrain** when online; location corrections persist.
- Windows and macOS.

## Repository layout

| Path | What |
|---|---|
| `crates/core` | Rust core: scan, metadata, media, bundle writer, local server |
| `crates/cli` | `photoway` command-line tool |
| `app/` | Tauri 2 desktop app |
| `viewer/` | The exported map viewer (TypeScript + MapLibre) |
| `schema/`, `docs/DATA_CONTRACT.md` | Project data format |
| `legacy/` | The original macOS scripts + Cesium template (reference) |

## Development

Requirements: Rust (stable), Node.js 24+. On Windows, the Visual Studio C++ build tools.

```sh
npm ci
npm run fixtures          # synthetic sample data → fixtures/sample/
npm run build:viewer      # viewer/dist
npm run dev:viewer        # viewer dev server on the sample data
cargo test --workspace
npm run tauri dev -w app  # desktop app
```

## Licence

MIT. HEIC decoding uses libheif/libde265 (LGPL-3.0), linked as documented in `docs/`.
