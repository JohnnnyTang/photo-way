#!/usr/bin/env node
// TEST HARNESS (not the product): assembles the built viewer (viewer/dist) and a project into the two
// output layouts of docs/DATA_CONTRACT.md so Playwright can open them from file://.
// Wave 2 (core::bundle) does this for real in Rust; keep the escaping rules in sync with the contract.
//
//   node viewer/scripts/make-test-pages.mjs [--project fixtures/sample/project.json] [--out viewer/.e2e] [--items N]
//
// Output:  <out>/single/photoway.html   (one file, thumbnails as a base64 pack, #pack: refs)
//          <out>/bundle/index.html      (+ assets/, data.js, thumbs/*.png)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const viewerDir = resolve(here, "..");
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])));
const projectPath = resolve(args.project ?? join(viewerDir, "..", "fixtures", "sample", "project.json"));
const outDir = resolve(args.out ?? join(viewerDir, ".e2e"));

const BACKSLASH = String.fromCharCode(92);
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** DATA_CONTRACT 2.1: `<` and U+2028/U+2029 escaped inside the JSON script. */
export const escapeJson = (json) =>
  json.split("<").join(`${BACKSLASH}u003c`).split(LINE_SEP).join(`${BACKSLASH}u2028`).split(PARA_SEP).join(`${BACKSLASH}u2029`);
/** DATA_CONTRACT 2.1: `</script` / `</style` neutralised inside inlined code. */
const escapeCode = (code, tag) => code.replace(new RegExp(`</${tag}`, "gi"), (m) => `<${BACKSLASH}/${m.slice(2)}`);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A small solid-gradient PNG (decoders sniff the bytes, so it is fine behind an image/jpeg blob). */
function png(seed, size = 64) {
  const rows = [];
  const hue = (seed * 47) % 360;
  const hsl = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const [r, g, b] = hsl(hue + (x + y) / 4, 0.6, 0.35 + (y / size) * 0.3);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function buildPages({ project, dist, out }) {
  const js = readFileSync(join(dist, "viewer.js"), "utf8");
  const css = readFileSync(join(dist, "viewer.css"), "utf8");
  const template = readFileSync(join(dist, "template.html"), "utf8");
  const fill = (tpl, map) => {
    let t = tpl;
    for (const [k, v] of Object.entries(map)) {
      if (t.split(k).length !== 2) throw new Error(`placeholder ${k} must appear exactly once`);
      t = t.replace(k, () => v);
    }
    return t;
  };

  const pngs = project.items.map((_, i) => png(i));

  // ---- single HTML ----
  const single = structuredClone(project);
  const parts = [];
  let offset = 0;
  single.items.forEach((it, i) => {
    const ref = `#pack:thumbs:${offset}:${pngs[i].length}`;
    it.thumb = ref;
    it.full = i % 3 === 0 ? null : ref; // exercise both "has full" and "thumb only"
    parts.push(pngs[i]);
    offset += pngs[i].length;
  });
  const pack = Buffer.concat(parts).toString("base64");
  const singleHtml = fill(template, {
    "{{PW_TITLE}}": escapeHtml(single.title),
    "<!--PW_STYLES-->": `<style>${escapeCode(css, "style")}</style>`,
    "<!--PW_DATA-->":
      `<script id="pw-data" type="application/json">${escapeJson(JSON.stringify(single))}</script>\n` +
      `<script id="pw-pack-thumbs" type="application/octet-stream" data-encoding="base64" data-mime="image/jpeg">${pack}</script>`,
    "<!--PW_SCRIPTS-->": `<script>${escapeCode(js, "script")}</script>`,
  });
  rmSync(join(out, "single"), { recursive: true, force: true });
  mkdirSync(join(out, "single"), { recursive: true });
  writeFileSync(join(out, "single", "photoway.html"), singleHtml);

  // ---- bundle ----
  const bundle = structuredClone(project);
  rmSync(join(out, "bundle"), { recursive: true, force: true });
  mkdirSync(join(out, "bundle", "assets"), { recursive: true });
  mkdirSync(join(out, "bundle", "thumbs"), { recursive: true });
  bundle.items.forEach((it, i) => {
    const name = `thumbs/${String(i).padStart(5, "0")}.png`;
    writeFileSync(join(out, "bundle", name), pngs[i]);
    it.thumb = name;
    it.full = name;
  });
  writeFileSync(join(out, "bundle", "data.js"), `window.__PHOTOWAY__ = ${escapeJson(JSON.stringify(bundle))};\n`);
  writeFileSync(join(out, "bundle", "assets", "viewer.js"), js);
  writeFileSync(join(out, "bundle", "assets", "viewer.css"), css);
  writeFileSync(
    join(out, "bundle", "index.html"),
    fill(template, {
      "{{PW_TITLE}}": escapeHtml(bundle.title),
      "<!--PW_STYLES-->": '<link rel="stylesheet" href="assets/viewer.css">',
      "<!--PW_DATA-->": '<script src="data.js"></script>',
      "<!--PW_SCRIPTS-->": '<script src="assets/viewer.js"></script>',
    }),
  );
  return { single: join(out, "single", "photoway.html"), bundle: join(out, "bundle", "index.html"), singleBytes: Buffer.byteLength(singleHtml) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  project.options = { ...project.options, basemap: "offline" }; // no network in tests
  if (args.items) project.items = project.items.slice(0, Number(args.items));
  const r = buildPages({ project, dist: join(viewerDir, "dist"), out: outDir });
  console.log(`single: ${r.single} (${(r.singleBytes / 1048576).toFixed(2)} MiB)\nbundle: ${r.bundle}`);
}
