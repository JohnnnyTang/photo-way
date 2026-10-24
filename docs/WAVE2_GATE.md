# Wave 2 integration gate (skeleton)

This file starts with the gates covered by Wave 2 · G (end-to-end and performance suite). Agents E and F, and the
final integration pass, add their rows. Status is what was observed locally on Windows 11 with the fallback
outputs and again with the real CLI (see "Output source" below); hosted CI is recorded once the `E2E` jobs have run.

## Output source

`scripts/e2e-outputs.mjs` produces the three outputs (single HTML, folder, zip extracted) under
`target/e2e-outputs/current/` and writes `manifest.json` with `source`:

| Source | When | What it builds |
|---|---|---|
| `cli` | `PW_CLI` (or `target/release/photoway[.exe]`) exists and a probe `photoway build` succeeds | `photoway build <12 generated geotagged JPEGs> -o ... --format html/dir/zip` (`scripts/gen-e2e-inputs.mjs`); HTTP via `photoway serve <out> --addr 127.0.0.1:0` |
| `fallback` | the CLI is missing or still prints "not implemented" | the reference layouts of `viewer/scripts/make-test-pages.mjs` on `fixtures/sample` (295 items); HTTP via a small Node static server |

`PW_E2E_REQUIRE_CLI=1` makes an unusable CLI a hard error; it is set in the `e2e` job of `.github/workflows/ci.yml`.
Local CLI run: 84 passed, 6 skipped (Chromium, Firefox, WebKit), `output-zip` budget included.

## Gates covered by the suite

Run with `npm run test:e2e -w viewer` (all engines) or `npx playwright test --project=chromium` inside `viewer/`.

| Gate | Spec | Local status (fallback outputs) | CLI outputs |
|---|---|---|---|
| Each output (html, dir, zip) x (file://, HTTP) x (Chromium, Firefox, WebKit): item count, map item count, route layer present, markers/clusters present | `outputs.spec.ts` | Passed (Chromium, Firefox, WebKit) | Passed |
| Timeline is virtualized, scrolls to the last item of the data, visible thumbnails decode | `outputs.spec.ts` | Passed | Passed |
| Zero console errors and page errors (only failed remote tile requests are ignored) | `outputs.spec.ts` | Passed | Passed |
| Modal opens and closes (double-click, Escape) | `outputs.spec.ts` | Passed | Passed |
| A visibility edit persists across reload and is stored under `photoway:<project.id>:edits` | `outputs.spec.ts` | Passed | Passed |
| "Save a copy" (single HTML): download opens, edit baked in, new project id, ids renumbered | `outputs.spec.ts` | Passed | Passed |
| 5,000-item single HTML: navigation to ready under `PW_PERF_LOAD_MS` (default 2500 ms; plan target about 2 s) and JS heap under `PW_PERF_HEAP_MB` (default 350 MB), Chromium | `perf.spec.ts` | Passed: about 1.2 s to ready, about 78 MB heap | n/a (synthetic project) |
| Size budgets on outputs: empty shell and fixture builds (`shell`, `output-html`, `output-dir`, `output-zip`) | `size.spec.ts`, `scripts/check-size.mjs` | Passed | Passed (`output-zip` only with the CLI) |

Readiness signal used by the specs: `window.__photoway__.stats()` reports `items > 0` and `map.loaded === true`
(the perf spec also waits for the first `.pw-tl-item`).

## Hosted CI

The `E2E` jobs first failed on both OSes: a few thumbnails served by `photoway serve` never loaded. tiny_http's
worker pool could queue a new connection behind idle browser keep-alive connections. `core::serve` now runs its own
thread-per-connection HTTP/1.1 server (regression test: `many_open_keep_alive_connections_are_all_answered`). After
that, every job was green on windows-latest, macos-latest and ubuntu-latest (run 40093387140), including
`E2E (windows-latest)` and `E2E (macos-latest)`.

## Manual app check (Windows 11)

The end-to-end flow in the desktop app (`tauri dev --release`, libheif on) on real geotagged phone photos: drop a
folder, scan and process, options, live preview, export as single HTML / folder / zip, open in browser, reveal,
serve, remembered settings. Outcome: all steps work.

It caught one bug, fixed before the check passed: preview thumbnails were broken images because the `pw` protocol
did not resolve `thumbs/...` refs (`bundle::thumb_for_ref`); exports were unaffected.

The check also led to a viewer addition, covered by `trip-order.spec.ts` and `tests/unit/trip.test.ts`: day-to-day
links readable on satellite (cased, dashed), and four switchable ways to read the trip's order (Filters > Trip
order): colour by time with a legend, numbered stops, hover highlight with faint context around a chosen day, and
playback.

A single-HTML export from the app was also opened in a phone browser: everything works there too.

Not checked yet: the same flow on macOS.

## Known gaps

- Route segment count is not observable: the viewer does not expose the MapLibre route source, so the specs assert
  that the route layer exists (`stats().map.hasRoute`) and that the number of mapped items equals the geotagged items
  minus GPS outliers. A route-segment assertion needs a diagnostics hook in `viewer/src`.
- Drag-to-correct is not covered; the persistence test uses the visibility edit (same storage path as fixes).
- With the CLI, the input is 12 tiny generated JPEGs (the committed HEIC has no GPS), so counts are small and there
  is no video or Live Photo; the fallback exercises the 295-item sample.
- Perf is measured on Chromium only (Firefox and WebKit expose neither the heap API nor comparable timing hooks).
- The `output-*` budgets allow the empty-shell budget plus 20 KiB per item for up to 300 items; tighten once the
  CLI fixture build is known.
