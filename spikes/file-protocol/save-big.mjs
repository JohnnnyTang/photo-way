// "Save a copy" on the 34 MB, 2,000-thumbnail single HTML (Chromium, Firefox, WebKit; file://).
import { chromium, firefox, webkit } from "@playwright/test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import path from "node:path";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 625 } });
  await page.goto(pathToFileURL(path.join(out, "thumbs-v6.html")).href + "#view=7.5,45.5,5");
  await page.waitForFunction(() => window.__spike?.idle, null, { timeout: 60000 });
  const t = Date.now();
  const [dl, res] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.__spike.saveCopy())]);
  const file = path.join(out, "dl", `big-copy-${name}.html`);
  await dl.saveAs(file);
  const ms = Date.now() - t;
  // reopen the copy and make sure it renders + decodes thumbnails
  const p2 = await browser.newPage({ viewport: { width: 1000, height: 625 } });
  await p2.goto(pathToFileURL(file).href + "#view=7.7491,46.0207,14.2");
  await p2.waitForFunction(() => window.__spike?.idle && window.__spike.thumbStats && window.__spike.thumbStats().imgsDecoded > 0, null, { timeout: 60000 });
  const copy = await p2.evaluate(() => ({ title: JSON.parse(document.getElementById("pw-data").textContent).title, thumbs: window.__spike.thumbStats(), errors: window.__spike.errors }));
  console.log(name, JSON.stringify({ serializeMs: res.ms, serializedChars: res.bytes, downloadAndSaveMs: ms, fileBytes: (await stat(file)).size, copy }));
  await browser.close();
}
