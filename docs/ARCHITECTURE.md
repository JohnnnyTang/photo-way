# Photo Way — Architecture

```
            ┌────────────────────── Desktop app (Tauri 2) ──────────────────────┐
 photos ──► │ app/ui (TS) ── commands ──► app/src-tauri ──► photoway-core        │
 folders    │   │  preview: viewer mounted in "preview" mode via custom protocol │
            └───┼────────────────────────────────────────────────────────────────┘
                │                     photoway CLI ──► photoway-core
                ▼
   photoway-core (Rust)
     scan   → walk inputs, classify files                    (Wave 1 · A)
     meta   → GPS / time+offset / dims / Live Photo pairing  (Wave 1 · A)
     media  → decode (image + libheif), thumbs, web-size, cache (Wave 1 · B)
     model  → Project / Item = DATA_CONTRACT v1               (Wave 0, frozen)
     bundle → Html | Dir | Zip writers, template injection    (Wave 2 · E)
     serve  → std-only HTTP/1.1 static server for dir | zip | html    (Wave 2 · E)
                │ embeds viewer/dist/* via include_bytes!
                ▼
   viewer (TS + MapLibre, IIFE)                               (Wave 1 · C)
     model · data loader (#pw-data | window.__PHOTOWAY__) · resolveRef (paths | packs)
     map (clusters, thumbnail markers, route + arrows, basemaps, globe, terrain)
     timeline (virtualized) · day nav · outliers · edits/persistence · modal · themes
```

## Build order
1. `npm run build -w viewer` → `viewer/dist/{viewer.js, viewer.css, template.html}`
2. `cargo build` (core embeds viewer/dist; build.rs fails with a clear message if it's missing)
3. `npm run tauri build -w app` (builds app/ui, then the Tauri bundle)

## Principles
- The exported output never uses `fetch()`, ES modules, or CDNs; it must work from `file://`.
- One viewer codebase for export *and* in-app preview.
- Core is UI-agnostic: progress via a trait, cancellation via a flag; the CLI and the app are thin.
- Everything the app needs is compiled into the binary (viewer assets, offline basemap).
- Pure Rust where possible; the only C dependency is libheif/libde265 (HEIC), isolated behind `media::Decoder`.

See [DATA_CONTRACT.md](DATA_CONTRACT.md) for formats and [PLAN.md](PLAN.md) for the waves.
