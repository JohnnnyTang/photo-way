// Synthetic 256x256 "photo-like" JPEGs (~12 KB at q78, like D5's thumbnails), deterministic per index.
import jpeg from "jpeg-js";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function makeThumb(i, { size = 256, quality = 78, noise = 20 } = {}) {
  const r = rng(i * 7919 + 13);
  const data = Buffer.alloc(size * size * 4);
  const hue = r() * 360, sky = [120 + r() * 100, 150 + r() * 80, 200 + r() * 55];
  const ground = [60 + r() * 120, 70 + r() * 100, 40 + r() * 60];
  const horizon = size * (0.35 + r() * 0.3), f1 = 2 + r() * 6, f2 = 7 + r() * 12, ph = r() * 6.28;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ridge = horizon + Math.sin(x / size * f1 + ph) * 22 + Math.sin(x / size * f2) * 9;
      const base = y < ridge ? sky : ground;
      const shade = y < ridge ? 1 - y / size * 0.4 : 0.6 + 0.4 * Math.sin((x + y) / (9 + (hue % 7)));
      const n = (r() - 0.5) * noise;
      const o = (y * size + x) * 4;
      data[o] = Math.max(0, Math.min(255, base[0] * shade + n));
      data[o + 1] = Math.max(0, Math.min(255, base[1] * shade + n));
      data[o + 2] = Math.max(0, Math.min(255, base[2] * shade + n));
      data[o + 3] = 255;
    }
  }
  // index label block (top-left) so markers are visibly distinct
  for (let b = 0; b < 12; b++) if ((i >> b) & 1) {
    for (let y = 8; y < 24; y++) for (let x = 8 + b * 12; x < 18 + b * 12; x++) {
      const o = (y * size + x) * 4; data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
    }
  }
  return jpeg.encode({ data, width: size, height: size }, quality).data;
}

if (process.argv[1].endsWith("gen-thumbs.mjs")) {
  let total = 0; const n = 40, t = performance.now();
  for (let i = 0; i < n; i++) total += makeThumb(i).length;
  console.log(`avg ${(total / n / 1024).toFixed(1)} KB, ${((performance.now() - t) / n).toFixed(1)} ms each`);
}
