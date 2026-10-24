# Photo Way — Development Plan

> Status: **approved** 2026-10-24 — decisions in §6 confirmed. Wave 0 done (spikes S1, S2 in `docs/spikes/`); Wave 1 next.
> Goal: a tiny, elegant desktop app (Windows + macOS) that turns a pile of geotagged
> phone photos/videos into a **portable, self-contained, shareable** route map —
> a single `.html` file or a small zip bundle — that works from `file://` and over HTTP.

---

## 0. Where the project is today

| Piece | What it does | Problems for the new goal |
|---|---|---|
| `export_photos.sh` | Exports a date range from macOS Photos.app via AppleScript, in daily batches of 100, with retries | macOS-only; had hard-coded personal paths (scrubbed in Wave 0; now script-relative + `$PYTHON`) |
| `gen_photo_map.py` | Reads EXIF GPS (exifread), HEIC via pillow_heif, video GPS via macOS `mdls`, video frames via `qlmanage`; writes 200px thumbnails (date label baked in), `photos.json`, copies the template | Needs Python + 3 pip packages; video path macOS-only; naive local time (no timezone) used for ordering |
| `external_template.html` | CesiumJS 1.119 (CDN) 3D map: thumbnail billboards, route + arrows, timeline, day navigation, 300 km/h outlier filter, drag-to-correct (localStorage), modal, basemap switcher | **`fetch('photos.json')` fails on `file://`** (the root reason it needs a server); Cesium from CDN ⇒ not self-contained and too heavy to inline (~10 MB+, workers/assets loaded by URL) |

The feature set of the template is good and will be ported. The architecture (separate thumbnails, lazy originals) is right; the delivery mechanism is what changes.

---

## 1. Product definition

### 1.1 The app (`Photo Way`)
1. Drop photos/folders (or pick them) → background scan shows: N files, N with location, date range, skipped files and why.
2. Live preview — the *exact* viewer that will be exported, rendered inside the app.
3. Options: title, which items to include, **full-size media: none / web-sized (long edge 1280–4096, default 2048) / originals** (user choice per export), privacy (strip EXIF from exported images, coordinate precision), default basemap, default theme.
4. Export as one of:
   - **Single HTML** — one file, everything inlined (viewer, map library, offline basemap, data, thumbnails). Best for sharing by chat/email.
   - **Folder / Zip bundle** — `index.html` + `assets/` + `data.js` + `thumbs/` + optional `media/`. Best for large trips with full-size photos.
5. "Open in browser" (file://) and "Serve" (built-in local HTTP server) buttons.

Also shipped: a `photoway` CLI (same core) — `build`, `serve`, `inspect`. It is what CI tests run against, and it's handy for power users.

### 1.2 The output (the thing people share)
- Opens by **double-click** (file://) in Chrome/Edge/Firefox/Safari, and when served by **any** static server — no fetch(), no ES modules, no CDN.
- Works **offline** with a built-in vector world basemap (Natural Earth land/borders/lakes, ~0.5 MB); upgrades to online satellite/topo/OSM tiles when online.
- **Self-persistent**: location corrections and visibility edits persist in `localStorage` (keyed by a bundle UUID). The single-HTML variant can **"Save a copy"** — it re-serializes itself with the corrections baked in, so edits travel with the file.
- Feature parity with the current template: route with direction arrows, start/end, timeline with day separators, day navigation, outlier filter, type filter, drag-to-correct, full-size modal (photo + video), fit-all, 2D / globe.
- **3D terrain basemap option** (online): MapLibre `raster-dem` terrain + hillshade from the keyless open AWS Terrain Tiles (Terrarium encoding), exaggeration slider, pitch/rotate; route and markers drape on terrain. Hidden/disabled when offline.
- **Theme selector** in the HTML: Auto (follows OS) / Light / Dark / plus a few curated palettes (e.g. "Dusk", "Paper", "Forest"). Implemented as CSS custom-property sets; persisted per viewer in localStorage; the exporter picks the default theme. Map basemap style and route/marker colours follow the theme.
- UI language: **English only**; all strings live in one module so localisation stays possible later.

### 1.3 Non-goals (v1)
Phone apps; cloud upload/hosting; editing photos; reading the Photos.app/Google Photos libraries directly (the legacy mac export script stays as an optional helper).

---

## 2. Key technical decisions (recommendations — confirm before Wave 0)

| # | Decision | Recommendation | Why / alternatives |
|---|---|---|---|
| D1 | App shell | **Tauri 2** (Rust backend + system WebView) | Installer ~5–15 MB, native on Win (WebView2) & macOS (WKWebView), and the preview *is* the viewer. Electron ≈ 100 MB+; Python+PyInstaller ≈ 50 MB with poor UI. |
| D2 | Map engine | **MapLibre GL JS 6.15.0 (exact pin)**, bundled by Vite into the IIFE | Globe, 3D terrain, hillshade; verified from `file://` in Chromium/Firefox/WebKit (S2). v6 is ESM-only: a Vite plugin inlines `maplibre-gl-worker.mjs` as a string (trailing `export{…}` stripped) and the entry calls `setWorkerUrl(blobUrl + "#maplibre-gl-worker.cjs")` for a *classic* blob worker. CI keeps a file:// smoke test (Chromium + WebKit). Fallback: 5.24.0 UMD (works unmodified, ~550 KB smaller, but end-of-life). Cesium is too heavy and breaks on `file://`. |
| D3 | Metadata | **`nom-exif`** (pure Rust) | GPS + time + offset from JPEG/HEIC/HEIF and from MOV/MP4 (QuickTime/ISO 6709 location) on both OSes. Replaces exifread + `mdls`. |
| D4 | HEIC decoding | **`libheif-rs` 3.0 (`default-features=false, features=["v1_17"]`) against libheif 1.23.5 + libde265 1.1.3 built static by vcpkg** (tag `2026.10.16`, `libheif[core]`, overlay triplets in `vcpkg/triplets/`), behind a `Decoder` trait | Verified on Win x64 (static CRT), macOS arm64/x64/universal (S1): +1.4–1.6 MB, ~0.3 s per 12 MP decode. `embedded-libheif` does **not** work (ignored on MSVC; no libde265 on macOS). LGPL-3: ship notices + licence texts, About-box credits, source tarball per release. macOS minimum 11.0. |
| D5 | Images | `image` + `fast_image_resize` + `jpeg-encoder` (pure Rust) | Thumbnails 256 px JPEG q≈78 (~12 KB). Web previews 2048 px long edge. EXIF orientation applied for JPEG/PNG/TIFF — **not** for HEIC (libheif already applies it). For thumbnails prefer the HEIC's embedded thumbnail item when it is ≥ 256 px (much faster than a full 12 MP decode). **No baked-in date label** — the viewer renders labels. |
| D6 | Video posters | Captured **in the app's webview** (`<video>` → canvas → PNG → backend), placeholder fallback | No ffmpeg/qlmanage. Works for H.264 everywhere and HEVC where the OS supports it. |
| D7 | Time | Order by **UTC** using `OffsetTimeOriginal` → GPS timestamp → naive local time; group days by **local** date | Fixes the current naive-timestamp ordering across time zones. |
| D8 | Viewer build | **TypeScript + Vite → one classic IIFE `viewer.js` + `viewer.css`** | Chrome blocks `type="module"` on `file://`. Output is embedded into the Rust binary (`include_bytes!`), so the app carries everything. |
| D9 | Data in output | `<script id="pw-data" type="application/json">` (single HTML) / `data.js` setting `window.__PHOTOWAY__` (bundle) | Script tags load from `file://`; fetch doesn't. Thumbnails in single HTML: base64 pack + offset table, decoded lazily to Blob URLs (the original version crashed browsers when it embedded data for ~1,700 photos). |
| D10 | Scale | Map: clustered GeoJSON source + DOM thumbnail markers only for in-viewport leaves (≤ ~150); timeline: virtualized | Smooth at 5,000 items. |
| D11 | Server | `tiny_http` static server in core (`photoway serve dir|zip|html`, the app's "Serve" button); also serves straight from a zip | Small, no runtime. |
| D12 | Repo/CI | Public GitHub repo, Cargo workspace + npm viewer, GitHub Actions; releases via `tauri-action` | Windows `.msi`/NSIS `.exe` + portable zip; macOS universal `.dmg`; CLI binaries for both. Unsigned at first (with documented Gatekeeper/SmartScreen steps); signing/notarization slots wired to secrets for later. |

### 2.1 Size budgets (enforced in CI)
| Artifact | Budget |
|---|---|
| Viewer JS+CSS (incl. MapLibre 6 + inlined worker) | ≤ 1.8 MB min / ≤ 480 KB gzip (MapLibre alone ≈ 1.65 MB / 441 KB) |
| Offline basemap (Natural Earth 1:50m TopoJSON, `viewer/basemap/`) | ≤ 600 KB (now 581 KB) |
| Empty single-HTML shell (viewer + basemap) | ≤ 2.6 MB |
| Single HTML, 1,000 photos (thumbs only) | ≈ 18 MB (base64 +33%; S2 measured 34.5 MB for 2,000, first render < 1.1 s in all engines) — app warns above ~50 MB and suggests a bundle |
| Installer | ≤ 15 MB each |

---

## 3. Target repository layout

```
photo-way/
├── Cargo.toml                 # workspace
├── crates/
│   ├── core/                  # photoway-core: scan, meta, media, model, bundle, serve
│   └── cli/                   # photoway CLI
├── app/                       # Tauri 2 app
│   ├── src-tauri/
│   └── ui/                    # app shell UI (TS, tiny; no framework or Preact/Svelte-lite)
├── viewer/                    # the exported viewer (TS + MapLibre) → dist/viewer.{js,css}
│   ├── src/
│   ├── basemap/               # Natural Earth → compact GeoJSON build script
│   └── tests/                 # vitest + Playwright
├── schema/photoway.v1.schema.json
├── fixtures/                  # synthetic geotagged media + sample.photoway.json
├── scripts/                   # fixture generation, size checks, version bump
├── legacy/                    # current scripts + Cesium template (scrubbed), kept as reference/helper
├── docs/ (PLAN.md, ARCHITECTURE.md, DATA_CONTRACT.md, USER_GUIDE.md)
└── .github/workflows/ (ci.yml, release.yml)
```

### 3.1 Contracts frozen in Wave 0 (they are what make parallel work possible)
- **Data contract v1** (`schema/photoway.v1.schema.json`):
  `{ version:1, id(uuid), title, generator, createdAt, items:[{ id, kind:"photo"|"video"|"live", name, t(ISO-8601 with offset or null), ts(UTC epoch ms), day("YYYY-MM-DD" local), lat, lon, alt?, w, h, dur?, thumb:{ref}, full?:{ref}, video?:{ref}, flags? }], options:{ basemap, lang, ... } }`
  where `ref` is a relative path (bundle) or `#pack:<offset>:<len>` (single HTML).
- **Viewer embed contract**: how the HTML template, data and thumbnail pack are injected (placeholders, `</script>` escaping rules), and the viewer's public init `PhotoWay.mount(el, data, { mode: "export" | "preview" })`.
- **Core API (Rust)**: `scan(inputs, &ScanOpts) -> ScanReport`, `process(&ScanReport, &MediaOpts, progress) -> Project`, `write(&Project, Format::{Html, Dir, Zip}, out)`, `serve(path, addr)`.

---

## 4. Execution in waves

Each wave is one lead session (me) that spawns parallel sub-agents, each in its own **git worktree** on its own branch with a written brief (scope, contract, acceptance tests, files it owns). The lead reviews, merges, and runs the integration check that closes the wave. Within a wave, agents only depend on the frozen contracts, never on each other's unmerged code.

```
Wave 0  Foundations + spikes ───────────────► contracts frozen, repo + CI green
Wave 1  A Metadata   B Media   C Viewer   D CI/Release      (4 parallel)
Wave 2  E Bundle+CLI+Serve   F Desktop app   G E2E/perf      (3 parallel)
Wave 3  H Docs   I Release hardening → v0.1.0   J Extras     (2–3 parallel)
```

### Wave 0 — Foundations & risk spikes (lead + 2 spike agents)
Lead (sequential):
1. `git init`; move current files to `legacy/`; **scrub personal paths** from `export_photos.sh`; add LICENSE (MIT/Apache-2.0 for our code; note LGPL libheif), README stub, `.gitignore`, `.editorconfig`.
2. Write `docs/ARCHITECTURE.md`, `docs/DATA_CONTRACT.md`, the JSON Schema, and `fixtures/sample.photoway.json` (synthetic: ~300 items over 4 days, 2 time zones, a flight, injected GPS spikes, videos, items with no time).
3. Scaffold: Cargo workspace (core + cli compile, empty modules), `viewer/` (Vite IIFE build emitting `dist/`), `app/` (Tauri 2 "hello" window), root scripts.
4. Create the public GitHub repo, push `main`, add a minimal CI (fmt/clippy/test, viewer typecheck/build) on windows-latest + macos-latest; branch protection: CI required.

Spike agents (parallel, throwaway branches):
- **S1 HEIC**: build `libheif-rs` embedded on Windows MSVC and macOS (arm64 + x86_64) in CI; decode a sample HEIC → 256 px JPEG; record build time, binary-size delta, and licensing notes. *Decides D4 or the fallback.*
- **S2 file://**: a minimal MapLibre page inlined into one HTML with offline Natural Earth GeoJSON + one online raster style; verify in Chrome, Edge, Firefox and Safari from `file://` and over HTTP; measure size; verify the localStorage behaviour on `file://` per browser.

**Exit:** contracts merged; CI green on both OSes; spike reports in `docs/spikes/`; D1–D12 confirmed or revised.

### Wave 1 — Core building blocks (4 parallel agents)
- **A · Metadata (`core::scan`, `core::meta`)** — recursive scan of files/folders; JPEG/HEIC/HEIF/PNG/TIFF/DNG + MOV/MP4/M4V; GPS (lat/lon/alt), DateTimeOriginal + OffsetTimeOriginal + GPS time → UTC; dimensions and orientation; **Live Photo pairing** (HEIC+MOV by name / ContentIdentifier); duplicate detection; a skip report (no GPS / unreadable / unsupported). Tests run on generated fixtures (`scripts/gen-fixtures` writes EXIF GPS into synthetic JPEGs; plus a few small committed HEIC/MOV samples that are CC0 or made by us).
- **B · Media (`core::media`)** — Decoder trait (image crate + libheif per S1); orientation-correct center-crop thumbnails; web-size previews with EXIF stripped; pass-through originals; poster-frame intake API (for D6); a content-hash **cache** so re-exports are instant; parallelism with rayon plus progress/cancel callbacks. Benchmark: 1,000 12 MP HEIC in under 60 s on a modern laptop (needs the embedded-thumbnail path plus parallel decoding; full decode is ~0.3 s each). Adds `scripts/setup-libheif.{ps1,sh}` (vcpkg clone at the pinned tag + install with `vcpkg/triplets`), the macOS x86_64 `libclang_rt.osx.a` link fix in a form that works from the library crate, a static-CRT `build.rs` for the CLI, and `THIRD_PARTY_NOTICES` generation. Follow `docs/spikes/S1-heic.md` exactly.
- **C · Viewer (`viewer/`)** — adopt the S2 setup first (`docs/spikes/S2-file-protocol.md`: MapLibre worker plugin, `viewer/basemap/` TopoJSON + `topojson-client`, `mapshaper@0.7.98` dev dependency, pack slice decoding, HTML cluster counts because there are no glyphs offline), then port all template features onto MapLibre against `fixtures/sample.photoway.json`: clustered markers with thumbnail markers at high zoom, route segments with direction arrows, start/end, virtualized timeline, day navigation and popover, outlier filter (`computeSuspects` port, same 300 km/h rule), type filter, drag-to-correct with localStorage per bundle id, **Export corrections** (JSON) and **Save a copy** (self-rewriting HTML), modal for photo and video with keyboard navigation, basemap switcher (offline Natural Earth / Esri satellite / satellite + labels / OpenTopoMap / OSM, with attributions), globe, **3D terrain basemap (AWS Terrarium DEM + hillshade, exaggeration control)**, **theme selector (auto/light/dark + curated palettes, CSS variables, persisted)**, responsive and touch-friendly, English strings centralised in one module. Unit tests (vitest) for outliers, day grouping and the thumb loader; Playwright smoke run on the fixture.
- **D · CI & release infra** — `ci.yml` (matrix win/mac/ubuntu: Rust fmt/clippy/test, viewer lint/test/build, size-budget check, artifact upload); `release.yml` on `v*` tags (`tauri-action`: Windows NSIS + MSI, macOS universal dmg; CLI binaries; checksums; draft release with notes from `CHANGELOG.md`); signing/notarization steps gated on secrets; Dependabot; version-sync script (Cargo, package.json, tauri.conf). vcpkg binary cache (`VCPKG_BINARY_SOURCES` + `actions/cache`, 8–13 s warm) for every Rust job; macOS universal build; a release job attaching the LGPL source tarball (libheif/libde265 sources, port patches, triplets).

**Exit:** each agent's PR merged with tests; the viewer renders the fixture from `file://` in Playwright; core produces thumbnails and metadata from fixtures on both OSes.

### Wave 2 — Integration (3 parallel agents)
- **E · Bundle, CLI, serve (`core::bundle`, `core::serve`, `crates/cli`)** — template injection per the embed contract (safe escaping), thumbnail pack for single HTML, Dir/Zip writers (content-addressed names, `README.txt` saying "unzip, then double-click index.html"), privacy options (EXIF strip, coordinate rounding), size estimation before export, `photoway build|serve|inspect`, serving directly from a zip; viewer assets embedded via `include_bytes!` from `viewer/dist` (with a clear build error when it's missing).
- **F · Desktop app (`app/`)** — drop zone and pickers; scan and process progress with cancel; summary and skip report; options panel; live preview (the viewer mounted in `preview` mode over a Tauri custom protocol); video poster capture (D6); export dialog with size estimate; open in browser / reveal in Explorer or Finder / serve; remembered settings; native menus; app icon. Talks to core through Tauri commands only.
- **G · E2E & performance** — CI job: CLI builds all three formats from fixtures on win + mac → Playwright (Chromium, Firefox, WebKit) opens each from `file://` and over HTTP via `photoway serve` → asserts marker/route/timeline counts, modal opens, zero console errors, correction persists across reload, "Save a copy" round-trips. Perf: a synthetic 5,000-item project loads under ~2 s with bounded memory. A size-budget gate on the outputs.

**Exit:** end-to-end user flow works in the app on Windows and macOS (manual check plus E2E green); outputs open on all four browsers.

### Wave 3 — Polish & first release (2–3 parallel agents)
- **H · Docs** — README (GIF, download links, quick start); USER_GUIDE: getting originals *with location* off iPhone (AirDrop "All Photos Data", or "Export Unmodified Original") and Android (Google Photos strips location from some shares; copy over USB), privacy guidance before sharing, unsigned-app first-run steps; legacy mac exporter documented as an optional helper.
- **I · Release hardening** — icons, about box, version stamping, `CHANGELOG`, tag `v0.1.0`, download and smoke-test the release artifacts on clean runners, verify file associations and uninstall.
- **J · Extras (backlog, pick by value)** — infer location for no-GPS photos from time neighbours (flagged); GPX import (real track) and export; per-day distance and elevation stats; privacy zones (hide around home); optional offline raster tiles for the route corridor from a source whose licence allows it; legacy `photos.json` importer.

---

## 5. Risks & mitigations
| Risk | Mitigation |
|---|---|
| libheif static build is fragile in CI / binary size | Spike S1 first; cache builds; fallback to an ImageIO backend (mac) or a WASM decoder in the webview (Windows) |
| Large single HTML is slow or crashes | Lazy Blob-URL thumbnails, clustering, virtualized timeline; app recommends a bundle above the threshold |
| `localStorage` on `file://` is shared or volatile across browsers | Key by bundle UUID; "Export corrections" and "Save a copy" as durable paths |
| Online tile terms (OSM / Esri) | Offline basemap by default when offline; attribution; configurable tile URLs; no bulk prefetch from OSM |
| Unsigned binaries trigger Gatekeeper / SmartScreen | Documented steps; signing hooks ready for when certificates exist |
| Location privacy when sharing | EXIF stripped from exported images by default; coordinate rounding option; privacy note in the export dialog |
| HEVC video playback unsupported in some browsers | Poster plus "download original"; optional web-friendly transcode is out of scope for v1 |

## 6. Decisions (confirmed 2026-10-24)
1. Public repo `photo-way` under the logged-in GitHub account; licence **MIT** (owner said "ok" without picking, so MIT was chosen; can switch to Apache-2.0 on request).
2. D1 Tauri ✔, D2 MapLibre ✔ (Cesium dropped) **plus a 3D terrain basemap option**, D4 bundled libheif (LGPL) ✔.
3. Full-size media in exports is a **per-export option**: none / web-sized / originals (UI pre-selects web-sized 2048 px).
4. UI language: **English only**.
5. New requirement: the exported HTML has a **theme selector**.
