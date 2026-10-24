import { describe, expect, it } from "vitest";
import { computeSuspects } from "../../src/outliers";

const point = (id: number, lon: number, minute: number) => ({ id, lat: 0, lon, ts: minute * 60_000 });

describe("computeSuspects", () => {
  it("flags an isolated GPS spike while preserving a sustained fast trip", () => {
    expect([...computeSuspects([point(0, 0, 0), point(1, 1, 1), point(2, 0.01, 2)])]).toEqual([1]);
    expect(computeSuspects([point(0, 0, 0), point(1, 1, 1), point(2, 2, 2), point(3, 3, 3)])).toEqual(new Set());
  });

  it("ignores undated items and orders by UTC", () => {
    const points = [point(2, 0.01, 2), { id: 3, lat: 80, lon: 80, ts: null }, point(0, 0, 0), point(1, 1, 1)];
    expect([...computeSuspects(points)]).toEqual([1]);
  });
});
