// Generates fixtures/sample/: a deterministic synthetic project (DATA_CONTRACT v1) in bundle layout.
// ~300 items over 4 days, two time zones, a flight, injected GPS spikes, videos, Live Photos,
// and one item without a capture time. Thumbnails are small SVGs (the viewer treats them as images).
//
//   node scripts/gen-sample-data.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sample");

let seed = 20260723;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const H = 3600_000;
const days = [
  // [local date, utc offset hours, start lat/lon, heading deg, km per hour walking/driving, count]
  ["2026-07-23", 8, 52.287, 104.281, 60, 25, 70], // Irkutsk → Listvyanka by road
  ["2026-07-24", 8, 51.854, 104.865, 20, 4, 80], // Listvyanka coast walk
  ["2026-07-25", 8, 53.16, 107.34, 35, 15, 75], // Olkhon island
  ["2026-07-26", 3, 55.756, 37.617, 300, 3, 70], // flew to Moscow (+03:00) — big jump between days
];

const items = [];
const pad = (n, w = 2) => String(n).padStart(w, "0");
const iso = (ms, off) => {
  const d = new Date(ms + off * H);
  const sign = off >= 0 ? "+" : "-";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}${sign}${pad(Math.abs(off))}:00`;
};

for (const [day, off, lat0, lon0, heading, kmh, count] of days) {
  let lat = lat0;
  let lon = lon0;
  let hdg = heading;
  // Local 08:00 that day in UTC ms.
  let ts = Date.parse(`${day}T08:00:00Z`) - off * H;
  for (let i = 0; i < count; i++) {
    const dtMin = 2 + rand() * 12;
    ts += Math.round(dtMin * 60_000);
    hdg += (rand() - 0.5) * 50;
    const km = (kmh * dtMin) / 60;
    lat += (km / 111) * Math.cos((hdg * Math.PI) / 180);
    lon += (km / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin((hdg * Math.PI) / 180);
    const r = rand();
    const kind = r < 0.08 ? "video" : r < 0.2 ? "live" : "photo";
    items.push({ kind, ts, off, day, lat, lon, alt: 450 + rand() * 300 });
  }
}

// Injected GPS spikes (isolated jumps the outlier filter should flag).
for (const at of [30, 120, 200]) {
  const it = items[at];
  it.lat += 1.8;
  it.lon -= 2.4;
  it.spike = true;
}
// One item without capture time.
items[150].noTime = true;

const out = items.map((it, id) => {
  const name = it.kind === "video" ? `IMG_${pad(1000 + id, 4)}.MOV` : `IMG_${pad(1000 + id, 4)}.HEIC`;
  const thumb = `thumbs/${pad(id, 5)}.svg`;
  const portrait = rand() < 0.4;
  return {
    id,
    kind: it.kind,
    name,
    time: it.noTime ? null : iso(it.ts, it.off),
    ts: it.noTime ? null : it.ts,
    tsSource: it.noTime ? null : "offset",
    day: it.noTime ? null : it.day,
    lat: +it.lat.toFixed(6),
    lon: +it.lon.toFixed(6),
    alt: +it.alt.toFixed(1),
    w: portrait ? 3024 : 4032,
    h: portrait ? 4032 : 3024,
    dur: it.kind === "photo" ? null : it.kind === "live" ? 2.9 : +(5 + rand() * 40).toFixed(1),
    thumb,
    full: it.kind === "video" ? null : thumb,
    video: null,
    ...(it.noTime ? { flags: ["noTime"] } : {}),
  };
});
// Contract: sorted by ts ascending, nulls last; ids equal indices.
out.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
out.forEach((it, i) => {
  it.id = i;
});

const project = {
  format: "photoway",
  version: 1,
  id: "00000000-0000-4000-8000-000000000001",
  title: "Sample trip — Lake Baikal & Moscow",
  generator: "gen-sample-data.mjs",
  createdAt: "2026-10-24T00:00:00Z",
  options: { theme: "auto", basemap: "auto", outlierSpeedKmh: 300 },
  items: out,
};

rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "thumbs"), { recursive: true });
for (const it of out) {
  const hue = Math.round((it.id * 137.5) % 360);
  const label = it.kind === "photo" ? "" : it.kind === "video" ? "▶" : "◎";
  writeFileSync(
    join(root, it.thumb),
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/>` +
      `<stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 38%)"/></linearGradient></defs>` +
      `<rect width="256" height="256" fill="url(#g)"/>` +
      `<text x="128" y="150" font-family="sans-serif" font-size="72" fill="#fff" fill-opacity=".9" text-anchor="middle">${it.id}${label}</text></svg>`,
  );
}
const json = JSON.stringify(project).replace(/</g, "\\u003c");
writeFileSync(join(root, "project.json"), JSON.stringify(project, null, 2));
writeFileSync(join(root, "data.js"), `window.__PHOTOWAY__ = ${json};\n`);
console.log(`fixtures/sample: ${out.length} items`);
