import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pageUrl = (kind: "single" | "bundle") => pathToFileURL(resolve(".e2e", kind, kind === "single" ? "photoway.html" : "index.html")).href;

for (const kind of ["single", "bundle"] as const) {
  test(`${kind} opens from file:// and supports core controls`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(pageUrl(kind));
    await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.items)).toBe(295);
    await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.map?.loaded), { timeout: 30_000 }).toBe(true);
    await expect(page.locator(".pw-tl-item").first()).toBeVisible();
    await page.getByRole("button", { name: "Theme" }).click();
    await page.locator('.pw-themeopt[data-id="dark"]').click();
    await expect(page.locator(".pw-root")).toHaveAttribute("data-theme", "dark");
    await page.locator(".pw-tl-item").first().click();
    await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.selected)).not.toBeNull();
    expect(errors).toEqual([]);
  });
}

test("visibility edits persist and a saved copy reopens with its own project id", async ({ page }, testInfo) => {
  await page.goto(pageUrl("single"));
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.map?.loaded), { timeout: 30_000 }).toBe(true);
  const originalId = await page.locator("#pw-data").evaluate((el) => JSON.parse(el.textContent!).id as string);
  await page.locator(".pw-tl-item input[type=checkbox]").first().uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.hidden)).toBe(1);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.hidden)).toBe(1);

  await page.getByRole("button", { name: "More" }).click();
  await page.locator(".pw-copyitem").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".pw-copybox .pw-primary").click(),
  ]);
  const copyPath = testInfo.outputPath("saved-copy.html");
  await download.saveAs(copyPath);
  const copy = await page.context().newPage();
  await copy.goto(pathToFileURL(copyPath).href);
  await expect.poll(() => copy.evaluate(() => (window as any).__photoway__?.stats()?.items)).toBe(294);
  const copied = await copy.locator("#pw-data").evaluate((el) => JSON.parse(el.textContent!) as { id: string; items: { id: number }[] });
  expect(copied.id).not.toBe(originalId);
  expect(copied.items.every((item, index) => item.id === index)).toBe(true);
  await copy.close();
});

test("filters, day navigation, and keyboard media navigation work offline", async ({ page }) => {
  await page.goto(pageUrl("single"));
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.map?.loaded), { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "Filters" }).click();
  await page.locator('.pw-seg-btn[data-v="video"]').click();
  const videoCount = await page.evaluate(() => (window as any).__photoway__.stats().onMap as number);
  expect(videoCount).toBeGreaterThan(0);
  expect(videoCount).toBeLessThan(295);
  await page.locator('.pw-seg-btn[data-v="all"]').click();
  await page.getByRole("button", { name: "Filters" }).click();

  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.locator(".pw-daylabel")).not.toHaveText("All days");
  await page.locator(".pw-tl-item").first().dblclick();
  await expect(page.locator(".pw-modal")).toBeVisible();
  const before = await page.locator(".pw-modal-counter").textContent();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".pw-modal-counter")).not.toHaveText(before ?? "");
  await page.keyboard.press("Escape");
  await expect(page.locator(".pw-modal")).toBeHidden();
});

test("5,000 items keep the timeline and map marker DOM bounded", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await page.goto(pageUrl("single"));
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.map?.loaded), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => {
    const project = JSON.parse(document.getElementById("pw-data")!.textContent!);
    const base = project.items[0];
    project.id = crypto.randomUUID();
    project.items = Array.from({ length: 5000 }, (_, id) => ({
      ...base, id, ts: base.ts + id * 1000,
      lat: base.lat + (id % 100) * 0.0001,
      lon: base.lon + Math.floor(id / 100) * 0.0001,
    }));
    (window as any).__photoway__.setProject(project);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__.stats().map?.loaded), { timeout: 30_000 }).toBe(true);
  const stats = await page.evaluate(() => (window as any).__photoway__.stats() as { items: number; timelineNodes: number; map: { pins: number } });
  expect(stats.items).toBe(5000);
  expect(stats.timelineNodes).toBeLessThan(100);
  expect(stats.map.pins).toBeLessThanOrEqual(151);
});
