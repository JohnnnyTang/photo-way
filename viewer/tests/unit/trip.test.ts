import { describe, expect, it } from "vitest";
import type { Item } from "../../src/model";
import { loadPrefs, type StorageLike } from "../../src/persist";
import { msPerStop } from "../../src/play";
import { buildRoute } from "../../src/route";
import { inkOn, oklch, parseHex, rampAt, RAMP_STEPS, rampExpression, timeRamp, tripOrder, tripT } from "../../src/trip";

const item = (id: number, ts: number | null, day: string | null, lon = id): Item => ({
  id, kind: "photo", name: `${id}.jpg`, time: null, ts, tsSource: null, day,
  lat: 0, lon, w: 10, h: 10, thumb: `${id}.jpg`,
});

const lightness = (hex: string) => oklch(parseHex(hex)!).l;

describe("trip order", () => {
  it("numbers timestamped items by capture time, whatever their id order", () => {
    const o = tripOrder([item(0, 300, "2026-10-05"), item(1, null, null), item(2, 100, "2026-10-04"), item(3, 200, "2026-10-04")]);
    expect(o.ids).toEqual([2, 3, 0]);
    expect([...o.number]).toEqual([[2, 1], [3, 2], [0, 3]]);
    expect([tripT(o, 2), tripT(o, 3), tripT(o, 0), tripT(o, 1)]).toEqual([0, 0.5, 1, null]);
  });

  it("puts a single stop at the start", () => {
    expect(tripT(tripOrder([item(0, 1, "2026-10-04")]), 0)).toBe(0);
  });
});

describe("time ramp", () => {
  for (const route of ["#d9480f", "#ffa94d", "#ffd43b", "#9c2f1e", "#9be564", "not a colour"]) {
    it(`goes from light to dark in one hue (${route})`, () => {
      const ramp = timeRamp(route);
      expect(ramp).toHaveLength(RAMP_STEPS);
      for (const c of ramp) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      const ls = ramp.map(lightness);
      for (let i = 1; i < ls.length; i++) expect(ls[i]!).toBeLessThan(ls[i - 1]!);
      expect(ls[0]! - ls[ls.length - 1]!).toBeGreaterThan(0.3);
      const hues = ramp.map((c) => oklch(parseHex(c)!).h);
      const spread = Math.max(...hues) - Math.min(...hues);
      expect(Math.min(spread, 360 - spread)).toBeLessThan(25);
    });
  }

  it("uses lighter steps on a dark surface, still light to dark", () => {
    const ls = timeRamp("#ffa94d", true).map(lightness);
    for (let i = 1; i < ls.length; i++) expect(ls[i]!).toBeLessThan(ls[i - 1]!);
    expect(Math.min(...ls)).toBeGreaterThan(0.5);
    expect(Math.max(...timeRamp("#ffa94d").map(lightness))).toBeLessThan(ls[0]!);
  });

  it("interpolates between steps and clamps outside 0..1", () => {
    const ramp = timeRamp("#d9480f");
    expect(rampAt(ramp, 0)).toBe(ramp[0]);
    expect(rampAt(ramp, 1)).toBe(ramp[RAMP_STEPS - 1]);
    expect(rampAt(ramp, -3)).toBe(ramp[0]);
    expect(rampAt(ramp, 1 / (RAMP_STEPS - 1))).toBe(ramp[1]);
    const mid = lightness(rampAt(ramp, 0.5 / (RAMP_STEPS - 1)));
    expect(mid).toBeLessThan(lightness(ramp[0]!));
    expect(mid).toBeGreaterThan(lightness(ramp[1]!));
  });

  it("builds the matching MapLibre expression", () => {
    const ramp = timeRamp("#d9480f");
    const e = rampExpression(ramp);
    expect(e.slice(0, 3)).toEqual(["interpolate", ["linear"], ["coalesce", ["get", "t"], 0]]);
    expect(e.slice(3)).toEqual(ramp.flatMap((c, i) => [i / (RAMP_STEPS - 1), c]));
  });

  it("picks dark ink on light stops and white ink on dark ones", () => {
    const ramp = timeRamp("#d9480f");
    expect(inkOn(ramp[0]!)).toBe("#16191d");
    expect(inkOn(ramp[RAMP_STEPS - 1]!)).toBe("#ffffff");
  });
});

describe("route legs", () => {
  it("keeps one leg per step with its item ids, index and kind", () => {
    const pts = [item(0, 1, "2026-10-04"), item(1, 2, "2026-10-04"), item(2, 3, "2026-10-05"), item(3, 4, "2026-10-05")];
    const r = buildRoute(pts, new Set([3]));
    expect(r.legs.map((l) => [l.a, l.b, l.i, l.kind])).toEqual([
      [0, 1, 0, "normal"],
      [1, 2, 1, "link"],
      [2, 3, 2, "suspect"],
    ]);
    expect(r.legs[1]!.coords).toEqual([[1, 0], [2, 0]]);
    expect(r.points.map((p) => p.id)).toEqual([0, 1, 2, 3]);
    expect(r.runs.map((x) => x.kind)).toEqual(["normal", "link", "suspect"]);
  });
});

describe("trip order switches", () => {
  const store = (v: unknown): StorageLike => ({ getItem: () => JSON.stringify(v), setItem: () => {}, removeItem: () => {} });

  it("loads booleans and ignores anything else", () => {
    expect(loadPrefs(store({ routeTimeColor: false, routeNumbers: true, routeHighlight: "yes" }))).toEqual({ routeTimeColor: false, routeNumbers: true });
  });
});

describe("playback pace", () => {
  it("lingers on short trips and keeps long ones moving", () => {
    expect(msPerStop(2)).toBe(1400);
    expect(msPerStop(12)).toBe(1400);
    expect(msPerStop(300)).toBeCloseTo(40000 / 299);
    expect(msPerStop(5000)).toBe(120);
  });
});
