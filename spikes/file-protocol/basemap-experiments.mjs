// Spike S2: try Natural Earth scale x simplification x format combos and print sizes.
// usage: node basemap-experiments.mjs <dir-with-ne-zips>
// Features of each layer are merged into ONE Multi* geometry (saves ~80 B/feature of JSON overhead).
import mapshaper from "mapshaper";
import { gzipSync } from "node:zlib";
import path from "node:path";

const dir = process.argv[2];
const z = (n) => path.join(dir, n + ".zip").replaceAll("\\", "/");

async function layer(scale, name, code, extra, simplify, precision) {
  const cmd = `-i ${z(`ne_${scale}_${name}`)} -target ne_${scale}_${name} ${extra} -simplify ${simplify} keep-shapes -clean -filter-fields -o ${code}.json format=geojson precision=${precision}`;
  const res = await mapshaper.applyCommands(cmd);
  const fc = JSON.parse(Buffer.from(Object.values(res)[0]).toString());
  const polys = [], lines = [];
  for (const f of fc.features ?? fc.geometries) {
    const g = f.geometry ?? f;
    if (!g) continue;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
    else if (g.type === "LineString") lines.push(g.coordinates);
    else if (g.type === "MultiLineString") lines.push(...g.coordinates);
  }
  const geometry = polys.length ? { type: "MultiPolygon", coordinates: polys } : { type: "MultiLineString", coordinates: lines };
  return { type: "Feature", properties: { k: code }, geometry };
}

const kb = (n) => (n / 1024).toFixed(0).padStart(5);
export async function build(scale, simplify, { rivers = 4, lakes = 4, precision = 0.001, landScale = scale, landSimplify = simplify } = {}) {
  const L = {
    land: await layer(landScale, "land", "land", "-filter-slivers min-area=20km2", landSimplify, precision),
    lake: await layer(scale, "lakes", "lake", `-filter "scalerank<=${lakes}" -filter-slivers min-area=20km2`, simplify, precision),
    border: await layer(scale, "admin_0_boundary_lines_land", "border", "", simplify, precision),
  };
  if (rivers >= 0) L.river = await layer(scale, "rivers_lake_centerlines", "river", `-filter "scalerank<=${rivers}"`, simplify, precision);
  return L;
}

async function run(label, ...args) {
  const L = await build(...args);
  const per = Object.entries(L).map(([k, v]) => k + "=" + (JSON.stringify(v).length / 1024).toFixed(0)).join(" ");
  const gj = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: Object.values(L) }));
  const out = { geojson: [gj.length, gzipSync(gj, { level: 9 }).length] };
  for (const q of [1e5, 2e5]) {
    const input = Object.fromEntries(Object.entries(L).map(([k, v]) => [k + ".json", JSON.stringify({ type: "FeatureCollection", features: [v] })]));
    const res = await mapshaper.applyCommands(`-i ${Object.keys(input).join(" ")} combine-files -o pw.json format=topojson quantization=${q} target=*`, input);
    const buf = Buffer.from(Object.values(res)[0]);
    out["topo q" + q.toExponential(0)] = [buf.length, gzipSync(buf, { level: 9 }).length];
  }
  console.log(label.padEnd(34), Object.entries(out).map(([k, [r, g]]) => `${k}: ${kb(r)} /${kb(g)} gz`).join(" | "), " [gj " + per + "]");
}

if (process.argv[1].endsWith("basemap-experiments.mjs")) {
  const runs = [
    ["50m 2km", "50m", "interval=2000"],
    ["50m 3km", "50m", "interval=3000"],
    ["50m 4km", "50m", "interval=4000"],
    ["50m 3km rivers<=3 lakes<=3", "50m", "interval=3000", { rivers: 3, lakes: 3 }],
    ["10m 3km", "10m", "interval=3000"],
    ["10m 4km", "10m", "interval=4000"],
    ["land10m 3km + 50m 3km rest", "50m", "interval=3000", { landScale: "10m" }],
    ["land10m 3km + 50m 3km r3 l3", "50m", "interval=3000", { landScale: "10m", rivers: 3, lakes: 3 }],
  ];
  for (const r of runs) await run(...r);
}
