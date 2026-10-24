// Spike S2: build every test page into ./out (gitignored).
//   node build-pages.mjs
import { build } from "vite";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { makeThumb } from "./gen-thumbs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const nm = (p) => path.join(here, "node_modules", p);
const rd = (p) => readFile(p, "utf8");
await mkdir(path.join(out, "assets"), { recursive: true });

// ---------- 1. Vite IIFE builds of the v6 entry ----------
// virtual:maplibre-worker = the worker source as a string. In "classic" mode the trailing ESM
// `export{X as default};` is removed and the result is checked to parse as a classic script.
function maplibreWorker(mode) {
  const ID = "virtual:maplibre-worker";
  return {
    name: "maplibre-worker-inline",
    resolveId: (id) => (id === ID ? "\0" + ID : null),
    async load(id) {
      if (id !== "\0" + ID) return null;
      let src = await rd(nm("maplibre-gl/dist/maplibre-gl-worker.mjs"));
      src = src.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
      if (mode === "classic") {
        const before = src.length;
        src = src.replace(/export\s*\{\s*\w+\s+as\s+default\s*\}\s*;?\s*$/, "\n");
        if (src.length === before) throw new Error("maplibre worker: expected a trailing `export{… as default}`");
        new vm.Script(src, { filename: "maplibre-gl-worker (classic)" }); // throws on any remaining import/export
      }
      return `export default ${JSON.stringify(src)};`;
    },
  };
}
async function viteIife(target, fileBase, mode = "classic") {
  await build({
    configFile: false, root: here, logLevel: "warn",
    define: { __WORKER_MODE__: JSON.stringify(mode) },
    plugins: [maplibreWorker(mode)],
    build: {
      outDir: "out/assets", emptyOutDir: false, target, minify: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      // MapLibre's `import.meta.url` (worker auto-detection) is unused once setWorkerUrl() is called.
      rolldownOptions: { transform: { define: { "import.meta": "{}" } } },
      lib: { entry: "src/entry-v6.js", name: "SpikeV6", formats: ["iife"], fileName: () => `${fileBase}.js`, cssFileName: fileBase },
    },
  });
}
await viteIife("es2022", "spike-v6", "classic");
await viteIife("es2022", "spike-v6-modworker", "module");
await viteIife("es2020", "spike-v6-es2020", "classic");

const v6js = await rd(path.join(out, "assets/spike-v6.js"));
const v6css = await rd(path.join(out, "assets/spike-v6.css"));
const v6js2020 = await rd(path.join(out, "assets/spike-v6-es2020.js"));
const v6jsMod = await rd(path.join(out, "assets/spike-v6-modworker.js"));
for (const [n, s] of [["spike-v6.js", v6js], ["maplibre5", await rd(nm("maplibre5/dist/maplibre-gl.js"))]]) {
  console.log(n, "contains </script:", /<\/script/i.test(s), " <!--:", s.includes("<!--"), " import.meta:", s.includes("import.meta"));
}

// ---------- 2. shared inputs ----------
const basemap = await rd(path.join(here, "../../viewer/basemap/world.topo.json"));
const scriptSafeJs = (s) => s.replace(/<\/(script)/gi, "<\\/$1");
const styleSafe = (s) => s.replace(/<\/(style)/gi, "<\\/$1");
const jsonForScript = (s) => s.replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");

function page({ title, css, bodyExtra = "", dataScripts = "", scripts }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${css}
</head>
<body>
<div id="photoway"></div>
${bodyExtra}
${dataScripts}
${scripts}
</body>
</html>
`;
}
const inlineCss = (...c) => `<style>${c.map(styleSafe).join("\n")}</style>`;
const inlineJs = (...j) => j.map((s) => `<script>${scriptSafeJs(s)}</script>`).join("\n");
const jsonTag = (id, text) => `<script id="${id}" type="application/json">${jsonForScript(text)}</script>`;

// ---------- 3. synthetic project + thumbnails ----------
const CITIES = [
  ["Paris", 2.3522, 48.8566], ["Lyon", 4.8357, 45.764], ["Geneva", 6.1432, 46.2044], ["Zermatt", 7.7491, 46.0207],
  ["Milan", 9.19, 45.4642], ["Venice", 12.3155, 45.4408], ["Florence", 11.2558, 43.7696], ["Rome", 12.4964, 41.9028],
];
function makeProject(n, title) {
  let s = 42; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const items = [], t0 = Date.UTC(2026, 6, 1, 7);
  for (let i = 0; i < n; i++) {
    const f = i / n * (CITIES.length - 1), c = Math.floor(f), frac = f - c;
    const a = CITIES[c], b = CITIES[Math.min(c + 1, CITIES.length - 1)];
    const inCity = frac < 0.8, w = inCity ? 0 : (frac - 0.8) / 0.2, spread = inCity ? 0.03 : 0.01;
    const lon = a[1] + (b[1] - a[1]) * w + (r() - 0.5) * spread, lat = a[2] + (b[2] - a[2]) * w + (r() - 0.5) * spread;
    const ts = t0 + Math.round(f * 86400000 * 1.1);
    items.push({
      id: i, kind: "photo", name: `IMG_${String(i).padStart(4, "0")}.JPG`, time: new Date(ts + 2 * 3600e3).toISOString().slice(0, 19) + "+02:00",
      ts, tsSource: "offset", day: new Date(ts + 2 * 3600e3).toISOString().slice(0, 10), lat: +lat.toFixed(6), lon: +lon.toFixed(6),
      alt: null, w: 256, h: 256, dur: null, thumb: null, full: null, video: null,
    });
  }
  return { format: "photoway", version: 1, id: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"), title, generator: "spike-s2",
    createdAt: "2026-10-24T00:00:00Z", options: { theme: "auto", basemap: "offline", outlierSpeedKmh: 300 }, items };
}

async function thumbs(n) {
  const cache = path.join(out, `thumbs-${n}.bin`), idx = path.join(out, `thumbs-${n}.json`);
  if (existsSync(cache) && existsSync(idx)) return { pack: await readFile(cache), offsets: JSON.parse(await rd(idx)) };
  const t = performance.now(), parts = [], offsets = [];
  let off = 0;
  for (let i = 0; i < n; i++) { const j = makeThumb(i); parts.push(j); offsets.push([off, j.length]); off += j.length; }
  const pack = Buffer.concat(parts);
  await writeFile(cache, pack); await writeFile(idx, JSON.stringify(offsets));
  console.log(`generated ${n} thumbs, ${(pack.length / n / 1024).toFixed(1)} KB avg, ${((performance.now() - t) / 1000).toFixed(1)} s`);
  return { pack, offsets };
}

function singleHtmlWithPack(title, n, th, extra = "") {
  const p = makeProject(n, title);
  p.items.forEach((it, i) => (it.thumb = `#pack:thumbs:${th.offsets[i][0]}:${th.offsets[i][1]}`));
  return page({
    title, css: inlineCss(v6css), bodyExtra: extra,
    dataScripts: [jsonTag("pw-basemap", basemap), jsonTag("pw-data", JSON.stringify(p)),
      `<script id="pw-pack-thumbs" type="application/octet-stream" data-encoding="base64">${th.pack.toString("base64")}</script>`].join("\n"),
    scripts: inlineJs(v6js),
  });
}

// ---------- 4. pages ----------
const files = {};
// 4a. MapLibre 6 single HTML (no items) — offline basemap / raster / terrain / globe via #hash
files["map-v6.html"] = page({ title: "S2 map v6", css: inlineCss(v6css), dataScripts: jsonTag("pw-basemap", basemap), scripts: inlineJs(v6js) });
files["map-v6-modworker.html"] = page({ title: "S2 map v6 module worker", css: inlineCss(v6css), dataScripts: jsonTag("pw-basemap", basemap), scripts: inlineJs(v6jsMod) });
files["map-v6-es2020.html"] =page({ title: "S2 map v6 es2020", css: inlineCss(v6css), dataScripts: jsonTag("pw-basemap", basemap), scripts: inlineJs(v6js2020) });
// 4b. MapLibre 5.24 UMD inline (fallback comparison)
files["map-v5.html"] = page({
  title: "S2 map v5", css: inlineCss(await rd(nm("maplibre5/dist/maplibre-gl.css")), await rd(path.join(here, "src/spike.css"))),
  dataScripts: jsonTag("pw-basemap", basemap),
  scripts: inlineJs(await rd(nm("maplibre5/dist/maplibre-gl.js")), await rd(nm("topojson-client/dist/topojson-client.min.js")),
    await rd(path.join(here, "src/app.js")), "SpikeApp.start(maplibregl, topojson.feature);"),
});
// 4c. 2,000 thumbnails in one HTML
const th2000 = await thumbs(2000);
files["thumbs-v6.html"] = singleHtmlWithPack("S2 thumbs 2000", 2000, th2000);
// 4d. Save a copy (40 thumbs)
const th40 = await thumbs(40);
files["save-v6.html"] = singleHtmlWithPack("S2 save", 40, th40, '<button id="pw-save" type="button">Save a copy</button>');
// 4e. localStorage pages, three files in different folders
const lsPage = `<!doctype html><html><head><meta charset="utf-8"><title>ls</title></head><body><script>
var r = { origin: location.origin, path: location.pathname };
try {
  var n = +(localStorage.getItem("spike:counter") || 0) + 1;
  localStorage.setItem("spike:counter", String(n));
  localStorage.setItem("spike:seen:" + location.pathname.split("/").slice(-3).join("/"), String(Date.now()));
  r.counter = n; r.keys = Object.keys(localStorage).sort(); r.ok = true;
} catch (e) { r.ok = false; r.error = String(e); }
window.__ls = r; document.body.textContent = JSON.stringify(r);
</script></body></html>`;
files["ls/a/index.html"] = lsPage; files["ls/a/second.html"] = lsPage; files["ls/b/deeper/other.html"] = lsPage;

for (const [name, html] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(out, name)), { recursive: true });
  await writeFile(path.join(out, name), html);
  console.log(name.padEnd(24), (Buffer.byteLength(html) / 1024 / 1024).toFixed(2), "MB");
}

// 4f. Folder bundle (classic <script src>, data.js, thumbs/ files) with the same 2,000 items
const bdir = path.join(out, "bundle-v6");
await rm(bdir, { recursive: true, force: true });
await mkdir(path.join(bdir, "assets"), { recursive: true }); await mkdir(path.join(bdir, "thumbs"), { recursive: true });
const bp = makeProject(2000, "S2 bundle 2000");
for (const it of bp.items) {
  const [o, l] = th2000.offsets[it.id];
  it.thumb = `thumbs/${String(it.id).padStart(5, "0")}.jpg`;
  await writeFile(path.join(bdir, it.thumb), th2000.pack.subarray(o, o + l));
}
await writeFile(path.join(bdir, "assets/viewer.js"), v6js);
await writeFile(path.join(bdir, "assets/viewer.css"), v6css);
await writeFile(path.join(bdir, "data.js"), `window.__PHOTOWAY__ = ${jsonForScript(JSON.stringify(bp))};\nwindow.__PW_BASEMAP__ = ${jsonForScript(basemap)};\n`);
await writeFile(path.join(bdir, "index.html"), page({ title: "S2 bundle", css: '<link rel="stylesheet" href="assets/viewer.css">',
  dataScripts: '<script src="data.js"></script>', scripts: '<script src="assets/viewer.js"></script>' }));
console.log("bundle-v6/ written");
