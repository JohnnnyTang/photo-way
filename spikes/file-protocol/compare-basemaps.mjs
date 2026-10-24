// Render each out/alt-basemaps/*.topo.json (plus the committed one) at a few views, for visual comparison.
//   node compare-basemaps.mjs  -> out/compare/<variant>-<view>.jpg
import { chromium } from "@playwright/test";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
await mkdir(path.join(out, "compare"), { recursive: true });
const base = await readFile(path.join(out, "map-v6.html"), "utf8");
const variants = { committed: await readFile(path.join(here, "../../viewer/basemap/world.topo.json"), "utf8") };
for (const f of await readdir(path.join(out, "alt-basemaps"))) variants[f.replace(".topo.json", "")] = await readFile(path.join(out, "alt-basemaps", f), "utf8");
const VIEWS = { alps6: "9,45.6,6", venice8: "12.3,45.45,8", aegean6: "25,38,6", japan5: "137,36,5" };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 625 } });
for (const [name, topo] of Object.entries(variants)) {
  const html = base.replace(/(<script id="pw-basemap" type="application\/json">)[\s\S]*?(<\/script>)/, (_, a, b) => a + topo.replace(/</g, "\\u003c") + b);
  const file = path.join(out, "compare", `${name}.html`);
  await writeFile(file, html);
  for (const [v, view] of Object.entries(VIEWS)) {
    await page.goto("about:blank"); // a hash-only change would be a same-document navigation
    await page.goto(pathToFileURL(file).href + "#view=" + view);
    await page.waitForFunction(() => window.__spike?.idle, null, { timeout: 30000 });
    await page.screenshot({ path: path.join(out, "compare", `${name}-${v}.jpg`), type: "jpeg", quality: 75 });
  }
  console.log(name, (Buffer.byteLength(topo) / 1024).toFixed(0), "KiB");
}
await browser.close();
