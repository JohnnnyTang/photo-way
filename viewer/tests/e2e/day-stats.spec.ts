// Per-day distance, elevation and time on the fixture: shown in the summary line and the day list, live with edits.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pageUrl = pathToFileURL(resolve(".e2e", "single", "photoway.html")).href;
const stats = (page: Page) => page.evaluate(() => (window as any).__photoway__.stats());

async function open(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(pageUrl);
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.map?.loaded), { timeout: 30_000 }).toBe(true);
}

test("the summary and the day list show distance, elevation and time, and follow edits", async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  const s0 = await stats(page);
  expect(s0.tripStats.total.distanceKm).toBeGreaterThan(1);
  // Days add up to no more than the trip, which also holds the legs between days.
  const sum = s0.tripStats.days.reduce((n: number, d: any) => n + d.distanceKm, 0);
  expect(sum).toBeLessThanOrEqual(s0.tripStats.total.distanceKm + 1e-6);
  const withDistance = s0.tripStats.days.find((d: any) => d.distanceKm > 0.5 && d.key !== "none");
  expect(withDistance).toBeTruthy();

  // Whole trip in the summary line.
  await expect(page.locator(".pw-stats")).toContainText(/\d km|\d m\b/);

  // The day list carries a line per day.
  await page.locator(".pw-daypick").click();
  const row = page.locator(".pw-dayrow", { hasText: /\d (km|m)\b/ }).first();
  await expect(row).toBeVisible();
  const before = await row.locator(".pw-daystat").textContent();
  await page.screenshot({ path: resolve("..", "target", "day-stats.png") });
  await page.keyboard.press("Escape");

  // Choose that day, hide the middle item: the numbers change.
  await page.locator(".pw-daypick").click();
  await row.click();
  const shown = await page.locator(".pw-stats").textContent();
  const checks = page.locator(".pw-tl-item input.pw-tl-check");
  const n = await checks.count();
  expect(n).toBeGreaterThan(2);
  await checks.nth(Math.floor(n / 2)).uncheck();
  await expect.poll(async () => (await stats(page)).hidden).toBe(1);
  const s1 = await stats(page);
  const day1 = s1.tripStats.days.find((d: any) => d.key === withDistance.key);
  expect(day1.count).toBe(withDistance.count - 1);
  expect(day1.distanceKm).not.toBe(withDistance.distanceKm);
  await page.locator(".pw-daypick").click();
  const after = await page.locator(".pw-dayrow.is-current .pw-daystat").textContent();
  expect(after).not.toBe(before);
  expect(shown).toBeTruthy();
  expect(errors).toEqual([]);
});

test.beforeAll(() => mkdirSync(resolve("..", "target"), { recursive: true }));
