#!/usr/bin/env node
// Regenerates the README / USER_GUIDE screenshots in docs/img/ from the synthetic sample project.
// Offline basemap and a fixed viewport, so the output is the same on every run.
//
//   npm ci && npm run fixtures && npm run build -w viewer
//   node scripts/screenshots.mjs [--out docs/img]
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const outDir = resolve(arg("out") ?? join(root, "docs", "img"));
const pagesDir = join(root, "target", "screenshots", "pages");
mkdirSync(outDir, { recursive: true });

const make = spawnSync(process.execPath, [join(root, "viewer", "scripts", "make-test-pages.mjs"), "--out", pagesDir], {
  stdio: "inherit",
});
if (make.status !== 0) throw new Error("make-test-pages.mjs failed (run npm run fixtures and npm run build -w viewer first)");

const { chromium } = createRequire(join(root, "viewer", "package.json"))("@playwright/test");
const url = pathToFileURL(join(pagesDir, "single", "photoway.html")).href;

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: "light" });
const page = await ctx.newPage();

const shot = async (name) => {
  const file = join(outDir, name);
  await page.screenshot({ path: file });
  console.log(`${name}: ${(statSync(file).size / 1024).toFixed(0)} KB`);
};
const setTheme = async (id) => {
  await page.getByRole("button", { name: "Theme" }).click();
  await page.locator(`.pw-themeopt[data-id="${id}"]`).click();
  await page.keyboard.press("Escape");
};

await page.goto(url);
await page.locator(".pw-tl-item").first().waitFor();
await page.waitForFunction(() => window.__photoway__?.stats()?.map?.loaded === true);
await page.waitForTimeout(1500);

// 1. Overview, light theme, all days.
await setTheme("light");
await page.waitForTimeout(600);
await shot("viewer-overview.png");

// 2. One day selected (the route is coloured by time by default).
await page.getByRole("button", { name: "Next day" }).click();
await page.waitForTimeout(1800);
await shot("viewer-day.png");

// 3. Dark theme.
await setTheme("dark");
await page.waitForTimeout(800);
await shot("viewer-dark.png");

await browser.close();
