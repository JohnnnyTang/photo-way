#!/usr/bin/env node
// Builds the offline world basemap shipped inside every Photo Way export.
//
//   node viewer/basemap/build.mjs [--out viewer/basemap/world.topo.json] [--scale 50m]
//        [--interval 3000] [--lakes 3] [--rivers 3] [--quantization 100000] [--geojson out.geojson]
//
// Source: Natural Earth (public domain, https://www.naturalearthdata.com/about/terms-of-use/),
// downloaded from the official CDN https://naciscdn.org/naturalearth/<scale>/<theme>/<name>.zip
// and cached in viewer/basemap/.cache/ (gitignored).
//
// Output: one TopoJSON topology with four objects, each holding a single merged geometry:
//   land (MultiPolygon), lake (MultiPolygon), border (MultiLineString), river (MultiLineString)
// Decode in the viewer with topojson-client `feature(topo, topo.objects[k])` and tag `{k}`.
//
// Uses mapshaper (MPL-2.0, build-time only). If `mapshaper` is resolvable it is used in-process,
// otherwise the pinned CLI is run through `npx`. Wave 1: add `mapshaper@0.7.98` to viewer devDeps.
import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const MAPSHAPER = "mapshaper@0.7.98";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const cfg = {
  out: args.out ?? path.join(here, "world.topo.json"),
  scale: args.scale ?? "50m",
  interval: Number(args.interval ?? 3000), // metres; Visvalingam (mapshaper default) with keep-shapes
  lakes: Number(args.lakes ?? 3), // keep lakes with scalerank <= N
  rivers: Number(args.rivers ?? 3), // keep rivers with scalerank <= N (-1 = none)
  quantization: Number(args.quantization ?? 1e5),
  geojson: args.geojson, // optional: also write the merged GeoJSON (for size comparison)
};
const cacheDir = path.join(here, ".cache");

const LAYERS = [
  { k: "land", theme: "physical", name: "land", filter: "-filter-slivers min-area=20km2" },
  { k: "lake", theme: "physical", name: "lakes", filter: () => `-filter "scalerank<=${cfg.lakes}" -filter-slivers min-area=20km2` },
  { k: "border", theme: "cultural", name: "admin_0_boundary_lines_land", filter: "" },
  { k: "river", theme: "physical", name: "rivers_lake_centerlines", filter: () => `-filter "scalerank<=${cfg.rivers}"`, skip: () => cfg.rivers < 0 },
];

async function download(theme, name) {
  const file = `ne_${cfg.scale}_${name}.zip`;
  const dest = path.join(cacheDir, file);
  if (existsSync(dest)) return dest;
  const url = `https://naciscdn.org/naturalearth/${cfg.scale}/${theme}/${file}`;
  console.log("download", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// Run a mapshaper command. `inputs` maps file names used in `cmd` to their text content;
// returns { outputName: string }.
let api;
try { api = (await import("mapshaper")).default; } catch { api = null; }
async function mapshaper(cmd, inputs = {}) {
  if (api) {
    const out = await api.applyCommands(cmd, inputs);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [path.basename(k), Buffer.from(v).toString()]));
  }
  const dir = await mkdtemp(path.join(tmpdir(), "pw-basemap-"));
  try {
    for (const [n, text] of Object.entries(inputs)) await writeFile(path.join(dir, n), text);
    const r = spawnSync(`npx --yes ${MAPSHAPER} -quiet ${cmd}`, { cwd: dir, shell: true, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`mapshaper failed: ${r.stderr || r.stdout}`);
    const outName = /-o (\S+)/.exec(cmd)[1];
    return { [outName]: await readFile(path.join(dir, outName), "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function buildLayer(l) {
  const zip = (await download(l.theme, l.name)).replaceAll("\\", "/");
  const filter = typeof l.filter === "function" ? l.filter() : l.filter;
  const layerName = `ne_${cfg.scale}_${l.name}`;
  const out = await mapshaper(
    `-i "${zip}" -target ${layerName} ${filter} -simplify interval=${cfg.interval} keep-shapes -clean ` +
      `-filter-fields -o ${l.k}.json format=geojson precision=0.001`,
  );
  const fc = JSON.parse(Object.values(out)[0]);
  // Merge every feature into ONE Multi* geometry: properties are useless offline and each
  // Feature wrapper costs ~80 bytes.
  const polys = [], lines = [];
  for (const f of fc.features ?? fc.geometries) {
    const g = f.geometry ?? f;
    if (g?.type === "Polygon") polys.push(g.coordinates);
    else if (g?.type === "MultiPolygon") polys.push(...g.coordinates);
    else if (g?.type === "LineString") lines.push(g.coordinates);
    else if (g?.type === "MultiLineString") lines.push(...g.coordinates);
  }
  const geometry = polys.length ? { type: "MultiPolygon", coordinates: polys } : { type: "MultiLineString", coordinates: lines };
  return { type: "Feature", properties: { k: l.k }, geometry };
}

const feats = [];
for (const l of LAYERS) if (!l.skip?.()) feats.push(await buildLayer(l));

const inputs = Object.fromEntries(feats.map((f) => [`${f.properties.k}.json`, JSON.stringify({ type: "FeatureCollection", features: [f] })]));
const topoOut = await mapshaper(
  `-i ${Object.keys(inputs).join(" ")} combine-files -filter-fields -o world.topo.json format=topojson quantization=${cfg.quantization} target=*`,
  inputs,
);
const topo = JSON.parse(Object.values(topoOut)[0]);
delete topo.bbox;
const text = JSON.stringify(topo);
await writeFile(cfg.out, text);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`${path.relative(process.cwd(), cfg.out)}: ${kb(text.length)} (gzip ${kb(gzipSync(text, { level: 9 }).length)})`, cfg);
if (cfg.geojson) {
  const gj = JSON.stringify({ type: "FeatureCollection", features: feats });
  await writeFile(cfg.geojson, gj);
  console.log(`${cfg.geojson}: ${kb(gj.length)} (gzip ${kb(gzipSync(gj, { level: 9 }).length)})`);
}
