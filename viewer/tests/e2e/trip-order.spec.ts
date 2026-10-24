// Trip order on the map: colour by time, numbered stops, hover highlight, faint context around a day, playback.
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pageUrl = pathToFileURL(resolve(".e2e", "single", "photoway.html")).href;
const stats = (page: Page) => page.evaluate(() => (window as any).__photoway__.stats());

async function open(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(pageUrl);
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.map?.loaded)).toBe(true);
}

const toggle = async (page: Page, key: "timeColor" | "numbers" | "highlight") => {
  await page.getByRole("button", { name: "Filters" }).click();
  await page.locator(`label[for="pw-sw-look-${key}"]`).click();
  await page.getByRole("button", { name: "Filters" }).click();
};

test("colour by time and numbered stops are switches that persist", async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  let s = await stats(page);
  expect(s.map.look).toEqual({ timeColor: true, numbers: false, highlight: true });
  expect(s.legend).toBe(true);
  expect(s.numberedCards).toBe(0);
  expect(await page.locator(".pw-tl-item.has-trip").count()).toBeGreaterThan(0);
  // The ramp runs one hue from light to dark.
  expect(s.map.ramp).toHaveLength(9);

  await toggle(page, "numbers");
  await expect.poll(async () => (await stats(page)).numberedCards).toBeGreaterThan(0);
  await expect(page.locator(".pw-tl-item .pw-tl-num").first()).toHaveText("#1");
  await toggle(page, "timeColor");
  s = await stats(page);
  expect(s.legend).toBe(false);
  expect(await page.locator(".pw-tl-item.has-trip").count()).toBe(0);

  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__photoway__?.stats()?.map?.loaded)).toBe(true);
  s = await stats(page);
  expect(s.map.look).toEqual({ timeColor: false, numbers: true, highlight: true });
  expect(s.numberedCards).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("hovering a timeline card focuses its legs; a chosen day keeps the rest faint", async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  const card = page.locator(".pw-tl-item").nth(3);
  const id = Number(await card.getAttribute("data-id"));
  await card.hover();
  await expect.poll(async () => (await stats(page)).map.focus).toBe(id);
  await page.mouse.move(5, 5);
  await expect.poll(async () => (await stats(page)).map.focus).toBeNull();

  await page.getByRole("button", { name: "Next day" }).click();
  await page.mouse.move(5, 5);
  let s = await stats(page);
  expect(s.map.faintLegs).toBeGreaterThan(0);
  expect(s.map.legs).toBeGreaterThan(s.map.faintLegs);
  await toggle(page, "highlight");
  s = await stats(page);
  expect(s.map.faintLegs).toBe(0);
  expect(errors).toEqual([]);
});

test("playing the trip walks every stop and then shows the whole route again", async ({ page }) => {
  test.setTimeout(60_000); // a full playback on slow CI browsers
  const errors: string[] = [];
  await open(page, errors);
  const play = page.getByRole("button", { name: "Play the trip" });
  await play.click();
  await expect.poll(async () => (await stats(page)).play).toBe("playing");
  await expect.poll(async () => (await stats(page)).map.playing ?? -1).toBeGreaterThan(1);
  expect((await stats(page)).selected).not.toBeNull();

  // Clicking a card pauses (at 1x the trip is far from over); play resumes.
  await page.locator(".pw-tl-item").first().click();
  await expect.poll(async () => (await stats(page)).play).toBe("paused");
  await page.getByRole("button", { name: "Play the trip" }).click();
  await expect.poll(async () => (await stats(page)).play).toBe("playing");

  const speed = page.locator(".pw-speed");
  for (const x of ["2x", "4x", "8x"]) {
    await speed.click();
    await expect(speed).toHaveText(x);
  }
  await expect.poll(async () => (await stats(page)).play, { timeout: 45000 }).toBe("stopped");
  expect((await stats(page)).map.playing).toBeNull();
  expect(errors).toEqual([]);
});
