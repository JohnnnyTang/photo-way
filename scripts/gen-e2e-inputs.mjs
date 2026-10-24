#!/usr/bin/env node
// Writes a few tiny geotagged JPEGs (EXIF time, offset, GPS) for the CLI end-to-end run. Mirrors the EXIF layout of
// crates/core/tests/common. The pixels are a flat grey 64x48 baseline JPEG with minimal one-symbol Huffman tables,
// so no image encoder is needed.
//
//   node scripts/gen-e2e-inputs.mjs [outDir]          (default target/e2e-outputs/inputs)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const u16 = (n) => Buffer.from([n & 255, n >> 8]);
const u32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
const ascii = (tag, s) => ({ tag, typ: 2, count: s.length + 1, data: Buffer.from(`${s}\0`, "latin1") });
const long = (tag, v) => ({ tag, typ: 4, count: 1, data: u32(v) });
const rationals = (tag, vals) => ({ tag, typ: 5, count: vals.length, data: Buffer.concat(vals.flatMap(([n, d]) => [u32(n), u32(d)])) });

function ifd(entries, base) {
  entries = [...entries].sort((a, b) => a.tag - b.tag);
  const table = 2 + entries.length * 12 + 4;
  const head = [u16(entries.length)];
  const extra = [];
  let extraLen = 0;
  for (const e of entries) {
    head.push(u16(e.tag), u16(e.typ), u32(e.count));
    if (e.data.length <= 4) head.push(Buffer.concat([e.data, Buffer.alloc(4 - e.data.length)]));
    else {
      head.push(u32(base + table + extraLen));
      extra.push(e.data);
      extraLen += e.data.length;
      if (extraLen % 2 === 1) {
        extra.push(Buffer.alloc(1));
        extraLen++;
      }
    }
  }
  head.push(u32(0));
  return Buffer.concat([...head, ...extra]);
}

const dms = (v) => {
  v = Math.abs(v);
  const d = Math.trunc(v);
  const m = Math.trunc((v - d) * 60);
  const s = ((v - d) * 60 - m) * 60;
  return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
};

function exifTiff({ local, offset, lat, lon, w, h }) {
  const exifEntries = () => [ascii(0x9003, local), ascii(0x9011, offset), long(0xa002, w), long(0xa003, h)];
  const gpsEntries = [ascii(1, lat >= 0 ? "N" : "S"), rationals(2, dms(lat)), ascii(3, lon >= 0 ? "E" : "W"), rationals(4, dms(lon))];
  const ifd0 = (exifOff, gpsOff) => [long(0x8769, exifOff), long(0x8825, gpsOff)];
  const exifOff = 8 + ifd(ifd0(0, 0), 0).length;
  const gpsOff = exifOff + ifd(exifEntries(), 0).length;
  return Buffer.concat([Buffer.from("II*\0\x08\0\0\0", "latin1"), ifd(ifd0(exifOff, gpsOff), 8), ifd(exifEntries(), exifOff), ifd(gpsEntries, gpsOff)]);
}

function jpeg(shot) {
  const { w, h } = shot;
  const seg = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exifTiff(shot)]);
  const dqt = Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]);
  const sof = Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const dht = (cls) => Buffer.concat([Buffer.from([cls << 4]), Buffer.from([1, ...new Array(15).fill(0)]), Buffer.from([0])]);
  const sos = Buffer.from([1, 1, 0x00, 0, 63, 0]);
  const blocks = (w / 8) * (h / 8); // each block: DC category 0 ("0") + end of block ("0") = 2 zero bits
  const data = Buffer.alloc(Math.ceil((blocks * 2) / 8), 0);
  if ((blocks * 2) % 8) data[data.length - 1] = 0xff >> ((blocks * 2) % 8); // pad with 1 bits
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, app1), seg(0xdb, dqt), seg(0xc0, sof), seg(0xc4, dht(0)), seg(0xc4, dht(1)), seg(0xda, sos), data, Buffer.from([0xff, 0xd9])]);
}

export function writeInputs(out = join(root, "target", "e2e-outputs", "inputs")) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pad = (n) => String(n).padStart(2, "0");
  let n = 0;
  for (const [day, lat0, lon0] of [["2026:07:23", 30.1, -120.9], ["2026:07:24", 30.6, -120.3]]) {
    for (let i = 0; i < 6; i++) {
      const shot = { w: 64, h: 48, local: `${day} ${pad(9 + Math.floor(i / 2))}:${pad((i % 2) * 30)}:00`, offset: "+08:00", lat: lat0 + i * 0.01, lon: lon0 + i * 0.012 };
      writeFileSync(join(out, `IMG_${String(1000 + n++).padStart(4, "0")}.jpg`), jpeg(shot));
    }
  }
  return { dir: out, count: n };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = writeInputs(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`${r.dir}: ${r.count} geotagged JPEGs`);
}
