import { describe, expect, it } from "vitest";
import { formatCount, formatDay, LanguageState, normalizeLocale, resolveAppLocale, resolveExportLocale, resolveViewerLocale, viewerLanguageKey } from "../../../shared/locale";
import { messages } from "../../../shared/messages";
import { appCatalogs } from "../../../app/ui/src/catalog";
import { viewerCatalogs } from "../../src/catalog";

describe("locale contracts", () => {
  it("normalizes supported variants and rejects Traditional Chinese", () => {
    for (const tag of ["zh", "zh-CN", "zh_SG", "zh-Hans", "zh-Hans-CN"]) expect(normalizeLocale(tag)).toBe("zh-CN");
    for (const tag of ["en", "en-US", "EN_gb"]) expect(normalizeLocale(tag)).toBe("en");
    for (const tag of ["zh-TW", "zh-Hant", "fr-FR", "", 42, null]) expect(normalizeLocale(tag)).toBeNull();
  });

  it("uses the documented precedence and invalid-value defaults", () => {
    expect(resolveAppLocale("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveAppLocale("system", "zh-SG")).toBe("zh-CN");
    expect(resolveAppLocale("bad", "zh-TW")).toBe("en");
    expect(resolveExportLocale(undefined, "zh-CN")).toBe("zh-CN");
    expect(resolveExportLocale("en", "zh-CN")).toBe("en");
    expect(resolveViewerLocale("zh-CN", "en", "en-US")).toBe("zh-CN");
    expect(resolveViewerLocale(null, "zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveViewerLocale(null, undefined, "zh-Hans")).toBe("zh-CN");
    expect(resolveViewerLocale(null, "fr", "zh-CN")).toBe("en");
  });

  it("formats labels without changing stored days and notifies only on a change", () => {
    expect(formatCount(1234, "en")).toBe("1,234");
    expect(formatDay("2026-07-23", "zh-CN")).toContain("7月23日");
    expect(formatDay("2026-13-40", "zh-CN")).toBe("2026-13-40");
    expect(viewerLanguageKey("trip-a")).not.toBe(viewerLanguageKey("trip-b"));
    const state = new LanguageState("en");
    const seen: string[] = [];
    const unsubscribe = state.subscribe((locale) => seen.push(locale));
    state.set("en"); state.set("zh-CN"); unsubscribe(); state.set("en");
    expect(seen).toEqual(["zh-CN"]);
  });

  it("keeps both message catalogs in key parity", () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages["zh-CN"]).sort());
    for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
      const tokens = (value: string) => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
      expect(tokens(messages.en[key])).toEqual(tokens(messages["zh-CN"][key]));
    }
  });

  it("keeps app and viewer catalog shapes and placeholders in parity", () => {
    const compare = (en: unknown, zh: unknown): void => {
      expect(typeof zh).toBe(typeof en);
      if (Array.isArray(en)) {
        expect(Array.isArray(zh)).toBe(true);
        expect((zh as unknown[]).length).toBe(en.length);
        return;
      }
      if (typeof en === "object" && en !== null && zh !== null) {
        expect(Object.keys(zh as object).sort()).toEqual(Object.keys(en).sort());
        for (const key of Object.keys(en)) compare((en as Record<string, unknown>)[key], (zh as Record<string, unknown>)[key]);
      } else if (typeof en === "string") {
        const tokens = (s: string) => [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
        expect(tokens(zh as string)).toEqual(tokens(en));
      }
    };
    compare(appCatalogs.en, appCatalogs["zh-CN"]);
    compare(viewerCatalogs.en, viewerCatalogs["zh-CN"]);
    expect(appCatalogs["zh-CN"].basemaps.map(([id]) => id)).toEqual(appCatalogs.en.basemaps.map(([id]) => id));
    expect(appCatalogs["zh-CN"].themes.map(([id]) => id)).toEqual(appCatalogs.en.themes.map(([id]) => id));
  });
});
