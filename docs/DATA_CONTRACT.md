# Photo Way — Data & Embed Contract (v1)

This document was **frozen for Wave 1/2**. Wave 4 adds optional `options.lang` while
retaining version 1: older documents still deserialize, and older viewers ignore
the new option. Core (Rust), viewer (TS), and schema change together.
Machine-readable form: [`schema/photoway.v1.schema.json`](../schema/photoway.v1.schema.json).
Rust mirror: `crates/core/src/model.rs`. TS mirror: `viewer/src/model.ts`.

---

## 1. Project document

```jsonc
{
  "format": "photoway",           // constant
  "version": 1,                   // contract version
  "id": "6f1c…-uuid",             // per export; keys viewer localStorage
  "title": "Lake Baikal 2026",
  "generator": "photoway 0.1.0",
  "createdAt": "2026-10-24T10:00:00Z",
  "options": {
    "theme": "auto",              // default theme id (see §5); viewer may override per user
    "basemap": "auto",            // auto | offline | satellite | satellite-labels | topo | osm | terrain
    "outlierSpeedKmh": 300,       // threshold for computeSuspects()
    "lang": "zh-CN"              // optional; en | zh-CN; absent in older exports
  },
  "items": [ /* Item, sorted by ts ascending, nulls last */ ]
}
```

`options.lang` is the export's default UI language, independent of the app's own
language. New bilingual exports write `en` or `zh-CN`. Older exports omit it.
The viewer resolves a project-scoped saved language first, then this field, then
the browser language only when the field is absent, then English. An explicit
unsupported field value falls back to English. Language changes affect labels
and formatting only; `time`, `ts`, `day`, coordinates, ordering, and user-entered
content remain unchanged.

### 1.1 Item

| Field | Type | Notes |
|---|---|---|
| `id` | int ≥ 0 | Unique, equals index in `items` after sorting. |
| `kind` | `"photo"` \| `"video"` \| `"live"` | `live` = still + paired motion clip (iPhone Live Photo). |
| `name` | string | Original file name, display only. |
| `time` | string \| null | Capture time as written by the camera, ISO-8601. With offset if known (`2026-07-23T10:32:15+08:00`), otherwise naive (`2026-07-23T10:32:15`). |
| `ts` | int \| null | Capture instant, **UTC epoch milliseconds**. Used for ordering and speed calculations. |
| `tsSource` | `"offset"` \| `"gps"` \| `"naive"` \| `"file"` \| null | Where `ts` came from. `naive` = local time treated as UTC (ordering only reliable within one zone). |
| `day` | string \| null | Local calendar date `YYYY-MM-DD` used for day grouping. |
| `lat`, `lon` | number | WGS-84 decimal degrees, ≤ 6 decimals (exporter may round further for privacy). |
| `alt` | number \| null | Metres above sea level. |
| `w`, `h` | int | Display dimensions **after** EXIF orientation is applied (0 if unknown). |
| `dur` | number \| null | Seconds (video / live). |
| `thumb` | Ref | Required. Square JPEG, 256 px, orientation applied. |
| `full` | Ref \| null | Large still (web-sized or original). Null when the export option is "none". |
| `video` | Ref \| null | Motion file for `video` / `live`. Null when not exported. |
| `flags` | string[] | Optional. Known: `"corrected"` (location manually corrected), `"hidden"` (hidden by the user; kept in a saved copy only when the user chooses to keep hidden items), `"inferredLocation"`, `"noTime"`. Unknown flags must be ignored. |

### 1.2 Ref

A `Ref` is a string, one of:

- **Relative URL** (bundle mode): `thumbs/00012.jpg`, `media/00012-IMG_0001.jpg`. Path segments are URL-encoded; always `/`; never absolute, never `..`.
- **Pack ref** (single-HTML mode): `#pack:<pack>:<offset>:<length>` — bytes `[offset, offset+length)` of the decoded pack `<pack>` (see §2.1). The MIME type is implied by the field: `thumb`/`full` = `image/jpeg`, `video` = per pack `data-mime` (v1 never packs video).

Viewers decode only the base64 characters covering the requested bytes (`floor(offset/3)*4` … `ceil((offset+length)/3)*4`),
so packs are never decoded whole; this is why pack text must contain no whitespace.

Viewers resolve refs through a single `resolveRef(ref): string` function returning a usable URL (relative URL as-is, pack refs → lazily created `blob:` URL).

---

## 2. Output formats

### 2.1 Single HTML (`Format::Html`)

One file, no external requests except optional online map tiles.

```html
<!doctype html><html><head>
  <meta charset="utf-8"><title>{TITLE}</title>
  <style>{viewer.css}</style>
</head><body>
  <div id="photoway"></div>
  <script id="pw-data" type="application/json">{PROJECT_JSON}</script>
  <script id="pw-pack-thumbs" type="application/octet-stream" data-encoding="base64">{BASE64}</script>
  <!-- optional: pw-pack-full, same shape -->
  <script id="pw-basemap" type="application/json">{BASEMAP_JSON}</script>
  <script>{viewer.js}</script>
</body></html>
```

Escaping rules (the writer **must** apply them):
- `{TITLE}`: HTML-escaped (`& < > " '`).
- `{PROJECT_JSON}`: JSON with every `<` written as `\u003c` (prevents `</script>`/`<!--`), plus U+2028/U+2029 written as `\u2028`/`\u2029`.
- `{viewer.js}` / `{viewer.css}`: every `</script` / `</style` (case-insensitive) replaced with `<\/script` / `<\/style`.
- Packs: standard base64, no line breaks or other whitespace.
- `{BASEMAP_JSON}`: the contents of `viewer/dist/world.topo.json`, with `<` and U+2028/U+2029 escaped as for `{PROJECT_JSON}`.

`viewer.js` embeds the MapLibre worker (as a string, started as a classic `blob:` worker).
The offline basemap is inlined as `#pw-basemap` (TopoJSON, ~0.6 MB). Templates never use
`type="module"`, `fetch()` or `new Worker(<file URL>)`.

### 2.2 Bundle (`Format::Dir`, `Format::Zip`)

```
<root>/
├── index.html          # links assets + data.js; inlines the offline basemap
├── data.js             # window.__PHOTOWAY__ = {PROJECT_JSON};   (same escaping as §2.1)
├── assets/viewer.js
├── assets/viewer.css
├── thumbs/00000.jpg …
├── media/00000-<safe-name>.<ext> …   # only if full/video exported
└── README.txt          # "Unzip first, then double-click index.html"
```

`index.html` loads classic scripts only (`<script src>`, **never** `type="module"` and never `fetch()`), so it works from `file://`.

### 2.3 Template

`viewer/dist/template.html` is the bundle `index.html` and the skeleton for single HTML. Placeholders (each appears exactly once):

| Placeholder | Single HTML | Bundle |
|---|---|---|
| `{{PW_TITLE}}` | escaped title | escaped title |
| `<!--PW_STYLES-->` | `<style>…</style>` | `<link rel="stylesheet" href="assets/viewer.css">` |
| `<!--PW_DATA-->` | `pw-data` + pack scripts | `<script src="data.js"></script>` |
| `<!--PW_BASEMAP-->` | `<script id="pw-basemap" type="application/json">…</script>` | Same inline basemap script |
| `<!--PW_SCRIPTS-->` | `<script>…viewer.js…</script>` | `<script src="assets/viewer.js"></script>` |

---

## 3. Viewer runtime API

`viewer.js` is a classic IIFE exposing `window.PhotoWay`:

```ts
PhotoWay.mount(el: HTMLElement, project: Project, opts?: {
  mode?: "export" | "preview";              // preview = inside the app (no "Save a copy")
  resolveRef?: (ref: string) => string;      // override (app preview uses a custom protocol)
}): { destroy(): void; setProject(p: Project): void };
```

Auto-mount: on `DOMContentLoaded`, if `#photoway` exists and data is found in `#pw-data` or `window.__PHOTOWAY__`, the viewer mounts itself in `export` mode.

## 4. Persistence (viewer)

| Key | Content |
|---|---|
| `photoway:<project.id>:edits` | `{ fixes: { [itemId]: {lat, lon} }, hidden: number[] }` |
| `photoway:prefs` | `{ theme?: string, basemap?: string, terrainExaggeration?: number }` |
| `photoway:<project.id>:language` | `en` or `zh-CN`; added in Wave 4, independent per trip. |

All storage access is wrapped in try/catch; the viewer must work when storage is unavailable.

Storage scope (measured in spike S2): on `file://`, Chrome, Edge, Firefox and WebKit give **every local HTML file one
shared localStorage**, persistent across reloads and restarts; over HTTP it is per origin *including the port*.
Hence: `project.id` must be a random UUID v4; never enumerate or clear keys you do not own; keep values small
(all exported trips share one ~5 MB quota on file://); values carry `"v": 1`; `photoway:prefs` is intentionally
shared by all trips; stored corrections are readable by any other local page (mention in the privacy note).

**Corrections export** (`corrections.json`, importable by app/CLI):
```json
{ "format": "photoway-corrections", "version": 1, "projectId": "…",
  "fixes": [ { "id": 3, "name": "IMG_0004.HEIC", "lat": 53.1, "lon": 108.2 } ],
  "hidden": [ 7, 8 ] }
```

**Save a copy** (single HTML only), run synchronously from a click handler: clone `document.documentElement`,
empty `#photoway`, drop runtime-only attributes (e.g. `data-theme`), replace the text of `#pw-data` with the edited
project (escaped as in §2.1) and download `"<!doctype html>\n" + outerHTML` as `text/html`. Edits are baked in
(`lat/lon` replaced + `"corrected"` flag; hidden items removed, or kept with the `"hidden"` flag, per user choice).
The copy gets a **new `id`** (fresh UUID v4) and `createdAt`; items are renumbered so that `id` equals index again.
Because the id is new, the original's stored edits are never re-applied to the copy (they are keyed by item id and
would point at the wrong items after renumbering).

## 5. Themes

Theme ids: `auto` (follows `prefers-color-scheme`, maps to `light`/`dark`), `light`, `dark`, `dusk`, `paper`, `forest`. Implemented as CSS custom-property sets on `[data-theme]`. Unknown id → `auto`.

## 6. Rust core API (frozen for Wave 2; stubs in `crates/core/src/{bundle,serve,assets}.rs`)

```rust
scan::scan(inputs: &[PathBuf], opts: &ScanOptions, progress: &dyn Progress) -> Result<ScanReport>;
media::process(report: &ScanReport, opts: &MediaOptions, progress: &dyn Progress) -> Result<Prepared>;
bundle::project(report: &ScanReport, prepared: &Prepared, opts: &ExportOptions) -> Project; // bundle-layout refs
bundle::asset_for_ref(prepared: &Prepared, project: &Project, rel: &str) -> Option<&Asset>;  // app preview
bundle::estimate(prepared: &Prepared, project: &Project, format: Format, opts: &ExportOptions) -> u64;
bundle::write(prepared, project, format, out: &Path, opts: &ExportOptions, progress) -> Result<WriteReport>;
serve::serve(path: &Path, addr: SocketAddr) -> Result<ServerHandle>;  // dir | zip | html; .url() .stop() .wait()
assets::{VIEWER_JS, VIEWER_CSS, TEMPLATE_HTML, BASEMAP_JSON}: &[u8]   // viewer/dist, embedded
```

## 7. CLI (frozen for Wave 2; flags in `crates/cli/src/main.rs`)

```
photoway build <inputs>... -o <out> [--format html|dir|zip] [--title T] [--full none|web|original]
               [--web-edge 2048] [--no-video] [--keep-exif] [--coord-decimals N] [--cache DIR]
               [--theme ID] [--basemap ID]
photoway serve <dir|zip|html> [--addr 127.0.0.1:8765]   # first stdout line: "Serving <path> at <url>"; port 0 = any
photoway inspect <inputs>... [--json]                   # {"entries":[...],"skipped":[{"path","reason"}]}
```
Exit code 0 on success, non-zero with a one-line `error: …` on stderr otherwise.
