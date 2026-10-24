// Wave 2 · G perf: a synthetic 5,000-item single HTML must load and first-render quickly with bounded memory.
//
// Readiness signal: the viewer exposes window.__photoway__.stats(); "ready" = items loaded (5000), the map
// overlay is up (stats().map.loaded) and the first timeline row is in the DOM. An init script polls on
// requestAnimationFrame and records performance.now() (ms since navigation start) the first frame it holds.
//
// Thresholds (env-overridable, lenient for CI runners):
//   PW_PERF_ITEMS      item count                       default 5000
//   PW_PERF_LOAD_MS    navigation -> ready              default 2500  (plan target: about 2000)
//   PW_PERF_HEAP_MB    JS heap after ready (Chromium)   default 350
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { expect, repoRoot, test, toFileUrl } from "./helpers";

const ITEMS = Number(process.env.PW_PERF_ITEMS ?? 5000);
const LOAD_MS = Number(process.env.PW_PERF_LOAD_MS ?? 2500);
const HEAP_MB = Number(process.env.PW_PERF_HEAP_MB ?? 350);

let pagePath = "";

test.describe("perf", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "timing and performance.memory are measured on Chromium only");

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const dir = join(repoRoot, "target", "e2e-outputs", "perf");
    mkdirSync(dir, { recursive: true });
    const sample = join(dir, "sample");
    const gen = spawnSync(process.execPath, [join(repoRoot, "scripts", "gen-sample-data.mjs"), "--count", String(ITEMS), "--out", sample, "--no-thumbs"], { encoding: "utf8" });
    if (gen.status !== 0) throw new Error(`gen-sample-data failed: ${gen.stderr}`);
    const { buildPages } = await import(pathToFileURL(join(repoRoot, "viewer", "scripts", "make-test-pages.mjs")).href);
    const project = JSON.parse(readFileSync(join(sample, "project.json"), "utf8"));
    project.options = { ...project.options, basemap: "offline" };
    const built = buildPages({ project, dist: resolve("dist"), out: join(dir, "pages") });
    pagePath = built.single;
    console.log(`[perf] ${project.items.length} items, single HTML ${(built.singleBytes / 1048576).toFixed(2)} MiB`);
  });

  test(`${ITEMS} items load and first-render quickly with bounded memory`, async ({ page, errors }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      const w = window as any;
      const tick = () => {
        const s = w.__photoway__?.stats?.();
        if (s && s.items > 0 && s.map?.loaded === true && document.querySelector(".pw-tl-item")) w.__pwReadyAt = performance.now();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(toFileUrl(pagePath));
    await page.waitForFunction(() => (window as any).__pwReadyAt !== undefined, undefined, { timeout: 30_000 });
    const readyMs = await page.evaluate(() => (window as any).__pwReadyAt as number);
    const stats = await page.evaluate(() => (window as any).__photoway__.stats());
    const heap = await page.evaluate(() => {
      const m = (performance as any).memory;
      return m ? { usedMB: m.usedJSHeapSize / 1048576, totalMB: m.totalJSHeapSize / 1048576 } : null;
    });
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      return { domContentLoadedMs: n.domContentLoadedEventEnd, loadMs: n.loadEventEnd };
    });

    const summary = `[perf] items=${stats.items} ready=${readyMs.toFixed(0)} ms (limit ${LOAD_MS}) domContentLoaded=${nav.domContentLoadedMs.toFixed(0)} ms ` +
      `heap=${heap ? `${heap.usedMB.toFixed(1)} MB used / ${heap.totalMB.toFixed(1)} MB total (limit ${HEAP_MB})` : "n/a"} ` +
      `timelineNodes=${stats.timelineNodes} pins=${stats.map.pins} clusters=${stats.map.clusters}`;
    console.log(summary);
    test.info().annotations.push({ type: "perf", description: summary });

    expect(Math.abs(stats.items - ITEMS)).toBeLessThanOrEqual(Math.ceil(ITEMS * 0.01)); // per-day rounding
    expect(errors).toEqual([]);
    expect(stats.timelineNodes).toBeLessThan(150);
    expect(stats.map.pins).toBeLessThanOrEqual(151);
    expect(readyMs, "navigation to ready").toBeLessThan(LOAD_MS);
    if (heap) expect(heap.usedMB, "JS heap after ready").toBeLessThan(HEAP_MB);
  });
});
