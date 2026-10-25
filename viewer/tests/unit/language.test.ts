import { describe, expect, it } from "vitest";
import { resolveViewerLocale } from "../../../shared/locale";
import { viewerCatalogs } from "../../src/catalog";
import { loadLanguage, saveLanguage, type StorageLike } from "../../src/persist";
import { bakeProject } from "../../src/savecopy";
import type { Project } from "../../src/model";
import { formatStat, formatSpan } from "../../src/stats";

const project = (id: string): Project => ({
  format: "photoway", version: 1, id, title: "北京之旅", generator: "test", createdAt: "2026-10-24T00:00:00Z",
  options: {}, items: [],
});

describe("viewer language", () => {
  it("keeps manual choices isolated per project and tolerates unavailable storage", () => {
    const values = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    expect(saveLanguage("trip-a", "zh-CN", storage)).toBe(true);
    expect(loadLanguage("trip-a", storage)).toBe("zh-CN");
    expect(loadLanguage("trip-b", storage)).toBeNull();
    expect(saveLanguage("trip-b", "en", null)).toBe(false);
    expect(resolveViewerLocale(loadLanguage("trip-b", storage), "zh-CN", "en-US")).toBe("zh-CN");
  });

  it("has matching catalog keys and carries an explicit language in a baked copy", () => {
    expect(Object.keys(viewerCatalogs.en.menu).sort()).toEqual(Object.keys(viewerCatalogs["zh-CN"].menu).sort());
    const original = project("trip-a");
    const copy = bakeProject(original, { v: 1, fixes: {}, hidden: [] }, { newId: "copy", now: "2026-10-25T00:00:00Z" });
    copy.options = { ...copy.options, lang: "zh-CN" };
    expect(copy.options.lang).toBe("zh-CN");
    expect(original.options.lang).toBeUndefined();
  });

  it("formats Wave 3 trip stats in Chinese", () => {
    expect(formatSpan(7 * 60 * 60_000 + 12 * 60_000, "zh-CN")).toBe("7 小时 12 分钟");
    expect(formatStat({ key: "all", count: 2, distanceKm: 42.3, elevation: { gain: 610, loss: 580, min: 1, max: 100 }, spanMs: null }, true, "zh-CN"))
      .toContain("↑ 610 米 ↓ 580 米");
    expect(formatStat({ key: "all", count: 2, distanceKm: 42.3, elevation: null, spanMs: null }, true, "zh-CN"))
      .toBe("42.3 公里");
  });
});
