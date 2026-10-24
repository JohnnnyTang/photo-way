// Spike S2 runner: drives Chromium / Firefox / WebKit (and installed Chrome / Edge) over file:// and HTTP.
//   node run.mjs [--browsers chromium,firefox,webkit,chrome,msedge] [--only offline,terrain,...] [--protocols file,http] [--headed]
// Writes out/results.json (merged across runs) and screenshots into ../../docs/spikes/img/.
import { chromium, firefox, webkit } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start as startServer } from "./serve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const imgDir = path.join(here, "../../docs/spikes/img");
const scratch = path.join(out, "profiles");
await mkdir(imgDir, { recursive: true });
await mkdir(path.join(out, "dl"), { recursive: true });

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const BROWSERS = arg("browsers", "chromium,firefox,webkit").split(",");
const ONLY = arg("only", "")?.split(",").filter(Boolean);
const PROTOCOLS = arg("protocols", "file,http").split(",");
const HEADED = argv.includes("--headed");
const PORT = 8765;
const ENGINES = {
  chromium: [chromium, {}], firefox: [firefox, {}], webkit: [webkit, {}],
  chrome: [chromium, { channel: "chrome" }], msedge: [chromium, { channel: "msedge" }],
};

const server = await startServer(out, PORT);
const urlFor = (proto, rel, hash = "") =>
  (proto === "file" ? pathToFileURL(path.join(out, rel)).href : `http://127.0.0.1:${PORT}/${rel.replaceAll("\\", "/")}`) + (hash ? "#" + hash : "");

// ---- helpers ----
function procTreeMB(pid) {
  // Sum working set / private bytes of the browser process and all its descendants (Windows).
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount;
$ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add(${pid}); $changed = $true
while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $changed = $true } } }
$sel = $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
"{0} {1} {2}" -f (($sel | Measure-Object WorkingSetSize -Sum).Sum/1MB), (($sel | Measure-Object PrivatePageCount -Sum).Sum/1MB), $sel.Count`;
  const [ws, priv, n] = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  return { workingSetMB: Math.round(ws), privateMB: Math.round(priv), processes: n };
}

async function openPage(ctx, url, rec) {
  const page = await ctx.newPage();
  rec.console = []; rec.net = {}; rec.failed = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") rec.console.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => rec.console.push("pageerror: " + e.message.slice(0, 300)));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (!/^https?:$/.test(u.protocol) || u.hostname === "127.0.0.1") return;
    const k = `${u.hostname} ${r.status()}`; rec.net[k] = (rec.net[k] || 0) + 1;
  });
  page.on("requestfailed", (r) => { if (!r.url().startsWith("data:")) rec.failed.push(`${r.url().slice(0, 100)} ${r.failure()?.errorText}`); });
  const t = Date.now();
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  rec.loadEventMs = Date.now() - t;
  return page;
}
const waitIdle = (page, timeout = 60000) => page.waitForFunction(() => window.__spike && window.__spike.idle === true, null, { timeout, polling: 200 });
async function spikeState(page) {
  return page.evaluate(() => {
    const S = window.__spike, nav = performance.getEntriesByType("navigation")[0];
    const r = (v) => (v == null ? v : Math.round(v));
    return {
      engine: S.engine, webgl2: S.webgl2, errors: S.errors, tileErrors: S.tileErrors.slice(0, 5), tileErrorCount: S.tileErrors.length, tiles: S.tiles,
      ms: { domContentLoaded: r(nav?.domContentLoadedEventEnd), scriptStart: r(S.scriptStartMs), mapCtor: r(S.marks.mapCtorMs), load: r(S.marks.loadMs),
        firstIdle: r(S.marks.firstIdleMs), basemapDecode: +(S.marks.basemapDecodeMs ?? 0).toFixed(1) },
      pixels: S.pixels(), rendered: S.rendered(["land", "border", "lake", "river", "raster", "hillshade", "clusters", "leaves"].filter((l) => S.map.getLayer(l))),
      projection: S.map.getProjection?.()?.type, terrain: !!S.map.getTerrain?.(),
    };
  });
}
async function shot(page, name) { await page.screenshot({ path: path.join(imgDir, name), type: "jpeg", quality: 78 }); }

// ---- scenarios: (ctx, proto, browserName, rec) ----
const MAP_SCENARIOS = {
  offline: { page: "map-v6.html", hash: "view=10,30,1.3", shot: "offline-world" },
  "offline-dark": { page: "map-v6.html", hash: "view=10,30,1.3&theme=dark", shot: "offline-world-dark", onlyBrowser: "chromium" },
  "offline-z6": { page: "map-v6.html", hash: "view=9,45.5,6", shot: "offline-z6-alps", onlyBrowser: "chromium" },
  "offline-z8": { page: "map-v6.html", hash: "view=12.3,45.45,8", shot: "offline-z8-venice", onlyBrowser: "chromium" },
  "offline-v5": { page: "map-v5.html", hash: "view=10,30,1.3" },
  "offline-modworker": { page: "map-v6-modworker.html", hash: "view=10,30,1.3", timeout: 20000 },
  "offline-es2020": { page: "map-v6-es2020.html", hash: "view=10,30,1.3" },
  globe: { page: "map-v6.html", hash: "view=60,30,1.2&globe=1", shot: "globe-offline" },
  esri: { page: "map-v6.html", hash: "raster=esri&view=7.75,46.02,11", shot: "esri-zermatt" },
  osm: { page: "map-v6.html", hash: "raster=osm&view=2.35,48.85,5", shot: "osm-paris-z5" },
  terrain: { page: "map-v6.html", hash: "raster=esri&terrain=1&hillshade=1&view=7.6586,45.99,12,70,-25", shot: "terrain-matterhorn", elev: [7.6586, 45.9763] },
  "terrain-offline": { page: "map-v6.html", hash: "terrain=1&hillshade=1&view=7.70,46.0,10.5,60,-20", shot: "terrain-hillshade-offline", elev: [7.6586, 45.9763] },
  "globe-terrain": { page: "map-v6.html", hash: "globe=1&terrain=1&hillshade=1&raster=esri&view=8.5,46.2,4.5,45,0", shot: "globe-terrain", elev: [7.6586, 45.9763] },
  "terrain-v5": { page: "map-v5.html", hash: "raster=esri&terrain=1&hillshade=1&view=7.6586,45.99,12,70,-25", elev: [7.6586, 45.9763] },
};

async function runMap(ctx, proto, bname, sc, name, rec) {
  const page = await openPage(ctx, urlFor(proto, sc.page, sc.hash), rec);
  try {
    await waitIdle(page, sc.timeout ?? 90000);
    if (sc.elev) await page.waitForTimeout(500);
    Object.assign(rec, await spikeState(page));
    if (sc.elev) rec.elevationM = await page.evaluate(([a, b]) => window.__spike.elev(a, b), sc.elev);
    if (sc.shot && proto === "file" && bname === "chromium") await shot(page, sc.shot + ".jpg");
    if (sc.shot && proto === "file" && bname !== "chromium" && ["offline", "terrain"].includes(name)) await shot(page, `${sc.shot}-${bname}.jpg`);
    rec.ok = rec.webgl2 && rec.errors.length === 0 && rec.pixels.distinctColors > 3;
  } catch (e) {
    rec.ok = false; rec.exception = e.message.split("\n")[0];
    try { Object.assign(rec, { partial: await page.evaluate(() => ({ errors: window.__spike?.errors, tileErrors: window.__spike?.tileErrors, webgl2: window.__spike?.webgl2 })) }); } catch {}
  }
  await page.close();
}

async function runThumbs(ctx, proto, bname, rec, { pageName = "thumbs-v6.html" } = {}) {
  const page = await openPage(ctx, urlFor(proto, pageName, "view=7.5,45.5,5"), rec);
  try {
    await waitIdle(page, 120000);
    Object.assign(rec, await spikeState(page));
    rec.fitAll = await page.evaluate(() => window.__spike.thumbStats());
    if (proto === "file" && bname === "chromium" && pageName === "thumbs-v6.html") await shot(page, `thumbs-v6-clusters.jpg`);
    // zoom into Zermatt (≈250 items around the village) -> DOM thumbnail markers
    const t = Date.now();
    await page.evaluate(() => window.__spike.map.jumpTo({ center: [7.7491, 46.0207], zoom: 14.2 }));
    await waitIdle(page, 60000);
    await page.waitForFunction(() => { const s = window.__spike.thumbStats(); return s.markers > 0 && s.imgsDecoded === s.imgs; }, null, { timeout: 30000, polling: 100 });
    rec.zoomToThumbsMs = Date.now() - t;
    rec.zoomed = await page.evaluate(() => window.__spike.thumbStats());
    if (proto === "file" && bname === "chromium" && pageName === "thumbs-v6.html") await shot(page, `thumbs-v6-markers.jpg`);
    if (pageName === "thumbs-v6.html") rec.eagerFullPackDecode = await page.evaluate(() => window.__spike.decodeWholePack("thumbs"));
    rec.ok = rec.errors.length === 0 && rec.zoomed.imgsDecoded > 0;
  } catch (e) { rec.ok = false; rec.exception = e.message.split("\n")[0]; }
  await page.close();
}

async function runSave(ctx, proto, bname, rec) {
  const page = await openPage(ctx, urlFor(proto, "save-v6.html", "view=7.7491,46.0207,13"), rec);
  try {
    await waitIdle(page, 90000);
    // (a) with a user gesture: real click on the button
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click("#pw-save")]);
    const saved = path.join(out, "dl", `copy-${bname}-${proto}.html`);
    await dl.saveAs(saved);
    rec.gestureDownload = { ok: true, suggested: dl.suggestedFilename(), bytes: (await stat(saved)).size, failure: await dl.failure() };
    // reopen the copy from file:// and check it works and carries the edit
    const p2 = await openPage(ctx, pathToFileURL(saved).href + "#view=7.7491,46.0207,13", (rec.copy = {}));
    await waitIdle(p2, 90000);
    await p2.waitForFunction(() => { const s = window.__spike.thumbStats(); return s.markers > 0 && s.imgsDecoded === s.imgs; }, null, { timeout: 30000 });
    Object.assign(rec.copy, await p2.evaluate(() => {
      const d = JSON.parse(document.getElementById("pw-data").textContent);
      return { title: d.title, item0: [d.items[0].lat, d.items[0].lon, d.items[0].flags], thumbs: window.__spike.thumbStats(), errors: window.__spike.errors,
        hasCanvasLeftover: document.querySelectorAll("#photoway canvas").length };
    }));
    await p2.close();
  } catch (e) { rec.gestureDownload = { ok: false, error: e.message.split("\n")[0] }; }
  await page.close();
  // (b) no user gesture: programmatic a.click() from a timer
  const page3 = await openPage(ctx, urlFor(proto, "save-v6.html", "autosave=1&view=7.7491,46.0207,10"), (rec.noGesture = {}));
  try {
    const dl = await page3.waitForEvent("download", { timeout: 20000 });
    const saved = path.join(out, "dl", `copy-nogesture-${bname}-${proto}.html`);
    await dl.saveAs(saved);
    rec.noGesture.download = { ok: true, bytes: (await stat(saved)).size };
  } catch (e) { rec.noGesture.download = { ok: false, error: e.message.split("\n")[0] }; }
  rec.noGesture.result = await page3.evaluate(() => window.__spike.autosaveResult).catch(() => null);
  await page3.close();
  rec.ok = !!(rec.gestureDownload?.ok && rec.copy?.title?.endsWith("(copy)") && rec.copy?.thumbs?.imgsDecoded > 0 && rec.copy?.errors?.length === 0);
}

async function runLocalStorage(engine, opts, bname, rec) {
  // Persistent profile, so we can also check persistence across a full browser restart.
  const dir = path.join(scratch, `ls-${bname}`);
  await rm(dir, { recursive: true, force: true });
  const read = async (ctx, url) => { const p = await ctx.newPage(); await p.goto(url); const r = await p.evaluate(() => window.__ls); await p.reload(); const r2 = await p.evaluate(() => window.__ls); await p.close(); return [r, r2]; };
  const launch = () => engine.launchPersistentContext(dir, { ...opts, headless: !HEADED });
  let ctx = await launch();
  const steps = {};
  const pr = (p) => ({ counter: p.counter, ok: p.ok, origin: p.origin, keys: p.keys?.length, error: p.error });
  for (const [label, url] of [
    ["file a/index", urlFor("file", "ls/a/index.html")],
    ["file a/second (same folder)", urlFor("file", "ls/a/second.html")],
    ["file b/deeper/other (other folder)", urlFor("file", "ls/b/deeper/other.html")],
    ["http :8765 a/index", urlFor("http", "ls/a/index.html")],
    ["http :8765 b/deeper/other", urlFor("http", "ls/b/deeper/other.html")],
  ]) { const [r1, r2] = await read(ctx, url); steps[label] = { first: pr(r1), afterReload: pr(r2) }; }
  await ctx.close();
  ctx = await launch();
  { const [r1] = await read(ctx, urlFor("file", "ls/a/index.html")); steps["file a/index after browser restart"] = { first: pr(r1) }; }
  { const [r1] = await read(ctx, urlFor("http", "ls/a/index.html")); steps["http a/index after browser restart"] = { first: pr(r1) }; }
  await ctx.close();
  rec.steps = steps;
}

async function runMemory(engine, opts, bname, recs) {
  for (const [label, rel, hash, zoomThumbs] of [
    ["map-v6 offline (no items)", "map-v6.html", "view=7.5,45.5,5", false],
    ["thumbs-v6 2000, fit-all (clusters)", "thumbs-v6.html", "view=7.5,45.5,5", false],
    ["thumbs-v6 2000, zoomed (≤150 thumb markers)", "thumbs-v6.html", "view=7.5,45.5,5", true],
  ]) {
    const srv = await engine.launchServer({ ...opts, headless: !HEADED });
    const browser = await engine.connect(srv.wsEndpoint());
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 625 } });
    const rec = (recs[label] = {});
    const page = await openPage(ctx, urlFor("file", rel, hash), rec);
    await waitIdle(page, 120000);
    if (zoomThumbs) {
      await page.evaluate(() => window.__spike.map.jumpTo({ center: [7.7491, 46.0207], zoom: 14.2 }));
      await waitIdle(page, 60000);
      await page.waitForFunction(() => { const s = window.__spike.thumbStats(); return s.markers > 0 && s.imgsDecoded === s.imgs; }, null, { timeout: 30000 });
      rec.thumbs = await page.evaluate(() => window.__spike.thumbStats());
    }
    await page.waitForTimeout(1500);
    rec.firstIdleMs = await page.evaluate(() => Math.round(window.__spike.marks.firstIdleMs));
    if (bname === "chromium" || opts.channel) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("Performance.enable");
      const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
      rec.jsHeapUsedMB = Math.round(m.JSHeapUsedSize / 1048576); rec.domNodes = m.Nodes;
    }
    rec.process = procTreeMB(srv.process().pid);
    await browser.close(); await srv.close();
  }
}

// ---- main ----
const resultsFile = path.join(out, "results.json");
const results = existsSync(resultsFile) ? JSON.parse(await readFile(resultsFile, "utf8")) : {};
const want = (n) => !ONLY.length || ONLY.includes(n);
for (const bname of BROWSERS) {
  const [engine, opts] = ENGINES[bname];
  const R = (results[bname] ??= {});
  if (want("ls")) { console.log(bname, "localStorage"); await runLocalStorage(engine, opts, bname, (R.localStorage = {})); }
  if (want("mem")) { console.log(bname, "memory"); await runMemory(engine, opts, bname, (R.memory = {})); }
  const browser = await engine.launch({ ...opts, headless: !HEADED });
  R.version = browser.version();
  for (const proto of PROTOCOLS) {
    const P = (R[proto] ??= {});
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 625 }, acceptDownloads: true });
    for (const [name, sc] of Object.entries(MAP_SCENARIOS)) {
      if (!want(name) || (sc.onlyBrowser && (sc.onlyBrowser !== bname || proto !== "file"))) continue;
      const t = Date.now(); P[name] = {}; await runMap(ctx, proto, bname, sc, name, P[name]);
      console.log(bname, proto, name, P[name].ok ? "OK" : "FAIL", `${Date.now() - t} ms`, P[name].exception ?? "", JSON.stringify(P[name].errors ?? P[name].partial ?? ""));
    }
    if (want("thumbs")) { P.thumbs = {}; await runThumbs(ctx, proto, bname, P.thumbs); console.log(bname, proto, "thumbs", P.thumbs.ok ? "OK" : "FAIL", P.thumbs.exception ?? ""); }
    if (want("bundle")) { P.bundle = {}; await runThumbs(ctx, proto, bname, P.bundle, { pageName: "bundle-v6/index.html" }); console.log(bname, proto, "bundle", P.bundle.ok ? "OK" : "FAIL", P.bundle.exception ?? ""); }
    if (want("save")) { P.save = {}; await runSave(ctx, proto, bname, P.save); console.log(bname, proto, "save", P.save.ok ? "OK" : "FAIL", JSON.stringify(P.save.gestureDownload), JSON.stringify(P.save.noGesture?.download)); }
    await ctx.close();
  }
  await browser.close();
  await writeFile(resultsFile, JSON.stringify(results, null, 2));
}
server.close();
console.log("results ->", resultsFile);
