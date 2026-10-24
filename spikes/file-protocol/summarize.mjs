// Print a compact view of out/results.json:  node summarize.mjs [browser] [scenario]
import { readFileSync } from "node:fs";
const R = JSON.parse(readFileSync(new URL("./out/results.json", import.meta.url), "utf8"));
const [fb, fs] = process.argv.slice(2);
for (const [b, r] of Object.entries(R)) {
  if (fb && fb !== b) continue;
  console.log(`\n=== ${b} ${r.version}`);
  for (const proto of ["file", "http"]) {
    for (const [name, x] of Object.entries(r[proto] ?? {})) {
      if (fs && fs !== name) continue;
      const brief = {
        ok: x.ok, exc: x.exception, ms: x.ms, px: x.pixels, tiles: x.tiles, tileErr: x.tileErrorCount, tileErrors: x.tileErrors?.length ? x.tileErrors : undefined,
        net: x.net, failed: x.failed?.length ? x.failed.slice(0, 3) : undefined, elev: x.elevationM, proj: x.projection, terrain: x.terrain,
        rendered: x.rendered, console: x.console?.length ? x.console.slice(0, 4) : undefined, errors: x.errors?.length ? x.errors : x.partial,
        fitAll: x.fitAll, zoomed: x.zoomed, zoomMs: x.zoomToThumbsMs, eager: x.eagerFullPackDecode, loadEventMs: x.loadEventMs,
        gesture: x.gestureDownload, copy: x.copy && { title: x.copy.title, item0: x.copy.item0, thumbs: x.copy.thumbs, errors: x.copy.errors, canvas: x.copy.hasCanvasLeftover, console: x.copy.console },
        noGesture: x.noGesture && { dl: x.noGesture.download, res: x.noGesture.result, console: x.noGesture.console },
      };
      console.log(`- ${proto} ${name}:`, JSON.stringify(brief, (k, v) => (v === undefined ? undefined : v)));
    }
  }
  if (!fs && r.localStorage) for (const [k, v] of Object.entries(r.localStorage.steps ?? {})) console.log(`  ls ${k}:`, JSON.stringify(v));
  if (!fs && r.memory) for (const [k, v] of Object.entries(r.memory)) console.log(`  mem ${k}:`, JSON.stringify({ firstIdleMs: v.firstIdleMs, jsHeapUsedMB: v.jsHeapUsedMB, domNodes: v.domNodes, process: v.process, thumbs: v.thumbs, load: v.loadEventMs, console: v.console?.slice(0, 2) }));
}
