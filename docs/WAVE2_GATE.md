# Wave 2 integration gate (skeleton)

This file starts with the gates covered by Wave 2 · G (end-to-end and performance suite). Agents E and F, and the
final integration pass, add their rows. Status is what was observed locally on Windows 11 with the fallback
outputs (see "Output source" below); hosted CI is recorded once the `E2E` jobs have run.

## Output source

`scripts/e2e-outputs.mjs` produces the three outputs (single HTML, folder, zip extracted) under
`target/e2e-outputs/current/` and writes `manifest.json` with `source`:

| Source | When | What it builds |
|---|---|---|
| `cli` | `PW_CLI` (or `target/release/photoway[.exe]`) exists and a probe `photoway build` succeeds | `photoway build crates/core/tests/data -o ... --format html/dir/zip`; HTTP via `photoway serve <out> --addr 127.0.0.1:0` |
| `fallback` | the CLI is missing or still prints "not implemented" | the reference layouts of `viewer/scripts/make-test-pages.mjs` on `fixtures/sample` (295 items); HTTP via a small Node static server |

`PW_E2E_REQUIRE_CLI=1` makes an unusable CLI a hard error. It is commented out in the `e2e` job of
`.github/workflows/ci.yml` (TODO: enable when Wave 2 · E merges).

## Gates covered by the suite

Run with `npm run test:e2e -w viewer` (all engines) or `npx playwright test --project=chromium` inside `viewer/`.

| Gate | Spec | Local status (fallback outputs) | CLI outputs |
|---|---|---|---|
| Each output (html, dir, zip) x (file://, HTTP) x (Chromium, Firefox, WebKit): item count, map item count, route layer present, markers/clusters present | `outputs.spec.ts` | Passed (Chromium, Firefox, WebKit) | Pending Wave 2 · E |
| Timeline is virtualized, scrolls to the last item of the data, visible thumbnails decode | `outputs.spec.ts` | Passed | Pending Wave 2 · E |
| Zero console errors and page errors (only failed remote tile requests are ignored) | `outputs.spec.ts` | Passed | Pending Wave 2 · E |
| Modal opens and closes (double-click, Escape) | `outputs.spec.ts` | Passed | Pending Wave 2 · E |
| A visibility edit persists across reload and is stored under `photoway:<project.id>:edits` | `outputs.spec.ts` | Passed | Pending Wave 2 · E |
| "Save a copy" (single HTML): download opens, edit baked in, new project id, ids renumbered | `outputs.spec.ts` | Passed | Pending Wave 2 · E |
| 5,000-item single HTML: navigation to ready under `PW_PERF_LOAD_MS` (default 2500 ms; plan target about 2 s) and JS heap under `PW_PERF_HEAP_MB` (default 350 MB), Chromium | `perf.spec.ts` | Passed: about 1.2 s to ready, about 78 MB heap | n/a (synthetic project) |
| Size budgets on outputs: empty shell and fixture builds (`shell`, `output-html`, `output-dir`, `output-zip`) | `size.spec.ts`, `scripts/check-size.mjs` | Passed | `output-zip` only exists with the CLI |

Readiness signal used by the specs: `window.__photoway__.stats()` reports `items > 0` and `map.loaded === true`
(the perf spec also waits for the first `.pw-tl-item`).

## Known gaps

- Route segment count is not observable: the viewer does not expose the MapLibre route source, so the specs assert
  that the route layer exists (`stats().map.hasRoute`) and that the number of mapped items equals the geotagged items
  minus GPS outliers. A route-segment assertion needs a diagnostics hook in `viewer/src`.
- Drag-to-correct is not covered; the persistence test uses the visibility edit (same storage path as fixes).
- With the CLI, the fixture is the single geotagged HEIC in `crates/core/tests/data`, so counts are tiny; the
  fallback exercises the 295-item sample. Add richer media fixtures to get realistic CLI-built counts.
- Perf is measured on Chromium only (Firefox and WebKit expose neither the heap API nor comparable timing hooks).
- The `output-*` budgets allow the empty-shell budget plus 20 KiB per item for up to 300 items; tighten once the
  CLI fixture build is known.
