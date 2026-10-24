// Print raw / gzip -9 / brotli sizes of files (and the sum of all of them as one stream).
// usage: node sizes.mjs file...
import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";

const kb = (n) => (n / 1024).toFixed(1).padStart(8) + " KB";
const bufs = [];
for (const f of process.argv.slice(2)) {
  const b = readFileSync(f);
  bufs.push(b);
  console.log(kb(b.length), "raw", kb(gzipSync(b, { level: 9 }).length), "gz", kb(brotliCompressSync(b).length), "br ", f);
}
if (bufs.length > 1) {
  const all = Buffer.concat(bufs);
  console.log(kb(all.length), "raw", kb(gzipSync(all, { level: 9 }).length), "gz", kb(brotliCompressSync(all).length), "br ", "(all, concatenated)");
}
