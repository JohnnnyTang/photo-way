import { describe, expect, it } from "vitest";
import type { Item } from "../../src/model";
import { buildRoute } from "../../src/route";
import { computeTripStats, formatSpan, formatStat } from "../../src/stats";
import { haversineKm } from "../../src/util";

const HOUR = 3_600_000;

function item(id: number, day: number, hour: number, lat: number, lon: number, alt?: number): Item {
  const d = String(day).padStart(2, "0");
  const time = `2025-06-${d}T${String(hour).padStart(2, "0")}:00:00`;
  return { id, kind: "photo", name: `p${id}`, time, ts: Date.UTC(2025, 5, day, hour), tsSource: "offset", day: `2025-06-${d}`, lat, lon, alt, w: 1, h: 1, thumb: "" };
}
const none = new Set<number>();

describe("computeTripStats", () => {
  it("measures a degree of latitude as about 111 km", () => {
    const s = computeTripStats([item(0, 1, 8, 0, 0), item(1, 1, 9, 1, 0)], none);
    expect(s.days.get("2025-06-01")!.distanceKm).toBeCloseTo(111.19, 1);
    expect(s.days.get("2025-06-01")!.spanMs).toBe(HOUR);
  });

  it("keeps the day-to-day link out of the days but in the trip total", () => {
    const pts = [item(0, 1, 8, 0, 0), item(1, 1, 9, 0, 1), item(2, 2, 8, 10, 1), item(3, 2, 9, 10, 2)];
    const s = computeTripStats(pts, none);
    const a = haversineKm(0, 0, 0, 1);
    const b = haversineKm(10, 1, 10, 2);
    expect(s.days.get("2025-06-01")!.distanceKm).toBeCloseTo(a);
    expect(s.days.get("2025-06-02")!.distanceKm).toBeCloseTo(b);
    expect(s.total.distanceKm).toBeCloseTo(a + b + haversineKm(0, 1, 10, 1));
    expect(s.total.distanceKm).toBeCloseTo(buildRoute(pts, none).distanceKm);
    expect(s.total.count).toBe(4);
    expect(s.total.spanMs).toBe(24 * HOUR + HOUR);
  });

  it("does not count legs that touch a suspect, like the route", () => {
    const pts = [item(0, 1, 8, 0, 0), item(1, 1, 9, 50, 50, 900), item(2, 1, 10, 0, 1)];
    const s = computeTripStats(pts, new Set([1]));
    expect(s.total.distanceKm).toBe(0);
    expect(s.total.distanceKm).toBe(buildRoute(pts, new Set([1])).distanceKm);
    // Without the suspect (outlier filter on) the other two are joined.
    const f = computeTripStats([pts[0]!, pts[2]!], new Set([1]));
    expect(f.total.distanceKm).toBeCloseTo(haversineKm(0, 0, 0, 1));
  });

  it("uses the positions it is given (hidden items left out, corrected positions moved)", () => {
    const base = [item(0, 1, 8, 0, 0), item(1, 1, 9, 0, 1), item(2, 1, 10, 0, 2)];
    expect(computeTripStats(base, none).total.distanceKm).toBeCloseTo(haversineKm(0, 0, 0, 2));
    expect(computeTripStats([base[0]!, base[2]!], none).total.distanceKm).toBeCloseTo(haversineKm(0, 0, 0, 2));
    const moved = [base[0]!, { ...base[1]!, lat: 1 }, base[2]!];
    expect(computeTripStats(moved, none).total.distanceKm).toBeGreaterThan(haversineKm(0, 0, 0, 2) * 1.2);
    expect(computeTripStats([base[0]!], none).total.distanceKm).toBe(0);
  });

  it("counts elevation only past the hysteresis step", () => {
    const alts = [100, 104, 98, 103, 130, 125, 90, 95];
    const pts = alts.map((a, i) => item(i, 1, 8, 0, i * 0.001, a));
    const e = computeTripStats(pts, none).days.get("2025-06-01")!.elevation!;
    // 100 -> 130 (+30), then 130 -> 90 (-40); the 4 to 5 m wobble never counts.
    expect(e.gain).toBe(30);
    expect(e.loss).toBe(40);
    expect(e.min).toBe(90);
    expect(e.max).toBe(130);
  });

  it("needs two altitudes, and ignores suspects", () => {
    const one = computeTripStats([item(0, 1, 8, 0, 0, 100), item(1, 1, 9, 0, 1)], none);
    expect(one.days.get("2025-06-01")!.elevation).toBeNull();
    expect(one.total.elevation).toBeNull();
    const sus = computeTripStats([item(0, 1, 8, 0, 0, 100), item(1, 1, 9, 0, 1, 5000)], new Set([1]));
    expect(sus.total.elevation).toBeNull();
  });

  it("handles days without altitude or time, and a single item", () => {
    const noTs = { ...item(0, 1, 8, 0, 0), ts: null, time: null, day: null };
    const s = computeTripStats([item(1, 2, 8, 5, 5), item(2, 3, 8, 6, 6, 10), item(3, 3, 9, 6, 7, 40), { ...noTs, id: 4 }], none);
    const single = s.days.get("2025-06-02")!;
    expect(single).toMatchObject({ count: 1, distanceKm: 0, spanMs: null, elevation: null });
    expect(s.days.get("2025-06-03")!.elevation).toEqual({ gain: 30, loss: 0, min: 10, max: 40 });
    expect(s.days.get("none")!.spanMs).toBeNull();
    expect(s.total.elevation).toEqual({ gain: 30, loss: 0, min: 10, max: 40 });
    expect(computeTripStats([], none).total).toMatchObject({ count: 0, distanceKm: 0, spanMs: null, elevation: null });
  });
});

describe("formatStat", () => {
  it("writes a compact line and leaves out what is unknown", () => {
    const up = String.fromCharCode(0x2191);
    const down = String.fromCharCode(0x2193);
    const dot = String.fromCharCode(0xb7);
    const full = { key: "k", count: 3, distanceKm: 42.3, spanMs: 7 * HOUR + 12 * 60_000, elevation: { gain: 610, loss: 580, min: 0, max: 1 } };
    expect(formatStat(full)).toBe(`42.3 km ${dot} ${up} 610 m ${down} 580 m ${dot} 7 h 12 min`);
    expect(formatStat({ ...full, elevation: null, spanMs: null })).toBe("42.3 km");
    expect(formatStat({ ...full, distanceKm: 0.35, elevation: null }, false)).toBe("350 m");
    expect(formatStat(undefined)).toBe("");
    expect(formatSpan(45 * 60_000)).toBe("45 min");
    expect(formatSpan(3 * HOUR)).toBe("3 h");
  });
});
