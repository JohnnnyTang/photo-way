// Wave 2 · G: every export output (single HTML, folder, zip-extracted) opened from file:// and over HTTP.
// Outputs come from scripts/e2e-outputs.mjs (global setup): the photoway CLI when usable, else the reference layouts.
import type { Page } from "@playwright/test";
import { expect, projectOf, statsOf, test, toFileUrl, waitReady, type OutputId } from "./helpers";

const outputs: OutputId[] = ["html", "dir", "zip"];
const transports = ["file", "http"] as const;

test.beforeAll(({ manifest }) => {
  console.log(`[e2e] outputs source: ${manifest.source}${manifest.note ? ` (${manifest.note})` : ""}`);
});

for (const output of outputs) {
  for (const transport of transports) {
    test.describe(`${output} over ${transport}`, () => {
      const open = async (page: Page, manifest: { outputs: Record<OutputId, { file: string }> }, servers: (id: OutputId) => Promise<{ url: string }>) => {
        await page.goto(transport === "file" ? toFileUrl(manifest.outputs[output].file) : (await servers(output)).url);
        await waitReady(page);
      };

      test("counts, timeline virtualization and zero console errors", async ({ page, manifest, servers, errors }) => {
        const responses: string[] = [];
        page.on("response", (r) => { if (r.status() >= 400 || !r.ok()) responses.push(`${r.status()} ${r.url().slice(-40)}`); });
        page.on("requestfailed", (r) => responses.push(`FAILED ${r.url().slice(-40)} ${r.failure()?.errorText}`));
        await open(page, manifest, servers);
        const project = await projectOf(page);
        const total = project.items.length;
        const geotagged = project.items.filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lon)).length;
        const s = await statsOf(page);

        expect(s.items).toBe(total);
        // Map: shown items are the geotagged ones minus GPS outliers (hidden by default).
        expect(s.onMap + s.suspects).toBe(geotagged);
        expect(s.map?.hasRoute).toBe(true);
        expect((s.map?.pins ?? 0) + (s.map?.clusters ?? 0)).toBeGreaterThan(0);
        const fmt = (n: number) => n.toLocaleString("en-US");
        await expect(page.locator(".pw-stats")).toContainText(
          s.onMap === total ? `${fmt(total)} ${total === 1 ? "item" : "items"}` : `${fmt(s.onMap)} of ${fmt(total)} shown`,
        );

        // Timeline is virtualized: the first row is rendered, the DOM stays bounded, and scrolling to the end
        // reaches the last item of the data.
        await expect(page.locator(".pw-tl-item").first()).toBeVisible();
        expect(s.timelineNodes).toBeLessThanOrEqual(Math.min(total + 12, 150)); // rows include day headers
        const scroller = page.locator(".pw-tl-scroller");
        if (total > 40) {
          expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        }
        await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
        await expect
          .poll(() => page.locator(".pw-tl-item").evaluateAll((els) => Math.max(...els.map((e) => Number((e as HTMLElement).dataset.id)))))
          .toBe(total - 1);

        // Visible thumbnails resolve (pack refs, relative URLs, or served files). Off-screen rows are lazy
        // (loading="lazy") and may not have loaded, so only what is on screen is checked.
        const badImages = () =>
          page.locator(".pw-tl-item img").evaluateAll((all) => {
            const imgs = (all as HTMLImageElement[]).filter((i) => { const r = i.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth; });
            if (imgs.length === 0) return ["no visible thumbnails"];
            return imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => `${i.src.slice(0, 80)} complete=${i.complete} width=${i.naturalWidth}`);
          });
        await expect.poll(badImages, { message: `thumbnails (responses: ${JSON.stringify(responses)})` }).toEqual([]);
        expect(errors).toEqual([]);
      });

      test("modal opens and closes", async ({ page, manifest, servers, errors }) => {
        await open(page, manifest, servers);
        await page.locator(".pw-tl-item").first().dblclick();
        await expect(page.locator(".pw-modal")).toBeVisible();
        expect((await statsOf(page)).modalOpen).toBe(true);
        await page.keyboard.press("Escape");
        await expect(page.locator(".pw-modal")).toBeHidden();
        expect((await statsOf(page)).modalOpen).toBe(false);
        expect(errors).toEqual([]);
      });

      test("a visibility edit persists across reload, keyed by the bundle id", async ({ page, manifest, servers, errors }) => {
        await open(page, manifest, servers);
        const project = await projectOf(page);
        const first = page.locator(".pw-tl-item").first();
        const hiddenId = Number(await first.getAttribute("data-id"));
        await first.locator("input[type=checkbox]").uncheck();
        await expect.poll(async () => (await statsOf(page)).hidden).toBe(1);
        const key = `photoway:${project.id}:edits`;
        const stored = await page.evaluate((k) => localStorage.getItem(k), key);
        expect(stored, `localStorage[${key}]`).not.toBeNull();
        expect(JSON.parse(stored!).hidden).toEqual([hiddenId]);

        await page.reload();
        await waitReady(page);
        expect((await statsOf(page)).hidden).toBe(1);
        await expect(page.locator(`.pw-tl-item[data-id="${hiddenId}"] input[type=checkbox]`)).not.toBeChecked();
        expect(errors).toEqual([]);
      });

      if (output === "html") {
        test("Save a copy round-trips with the edit baked in", async ({ page, manifest, servers, errors }, testInfo) => {
          await open(page, manifest, servers);
          const project = await projectOf(page);
          const total = project.items.length;
          const first = page.locator(".pw-tl-item").first();
          const hiddenId = Number(await first.getAttribute("data-id"));
          const hiddenName = project.items[hiddenId].name;
          await first.locator("input[type=checkbox]").uncheck();
          await expect.poll(async () => (await statsOf(page)).hidden).toBe(1);

          await page.getByRole("button", { name: "More" }).click();
          await page.locator(".pw-copyitem").click();
          // With a single item, dropping it would leave an empty copy: keep it flagged instead.
          const keepHidden = total < 2;
          if (keepHidden) await page.locator("#pw-keep-hidden").check();
          const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".pw-copybox .pw-primary").click()]);
          const copyPath = testInfo.outputPath("saved-copy.html");
          await download.saveAs(copyPath);

          const copy = await page.context().newPage();
          const copyErrors: string[] = [];
          copy.on("pageerror", (e) => copyErrors.push(e.message));
          await copy.goto(toFileUrl(copyPath));
          await waitReady(copy);
          const baked = await projectOf(copy);
          expect(baked.id).not.toBe(project.id);
          expect(baked.items.every((it, i) => it.id === i)).toBe(true);
          if (keepHidden) {
            expect(baked.items).toHaveLength(total);
            expect(baked.items[0].flags).toContain("hidden");
          } else {
            expect(baked.items).toHaveLength(total - 1);
            expect(baked.items.map((i) => i.name)).not.toContain(hiddenName);
            expect((await statsOf(copy)).items).toBe(total - 1);
          }
          // The copy starts clean: nothing from the original's stored edits is re-applied to it.
          expect((await statsOf(copy)).edited).toBe(0);
          expect(copyErrors).toEqual([]);
          await copy.close();
          expect(errors).toEqual([]);
        });
      }
    });
  }
}
