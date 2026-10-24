import { describe, expect, it } from "vitest";
import { buildRows, groupByDay } from "../../src/days";
import type { Item } from "../../src/model";

const item = (id: number, ts: number | null, day: string | null): Item => ({
  id, kind: "photo", name: `${id}.jpg`, time: null, ts, tsSource: null, day,
  lat: 0, lon: 0, w: 10, h: 10, thumb: `${id}.jpg`,
});

describe("day grouping", () => {
  it("orders by UTC but groups each camera's local day, with undated items last", () => {
    const groups = groupByDay([
      item(3, null, null), item(2, 200, "2026-07-24"),
      item(0, 100, "2026-07-24"), item(1, 150, "2026-07-23"),
    ]);
    expect(groups).toEqual([
      { key: "2026-07-24", ids: [0, 2] },
      { key: "2026-07-23", ids: [1] },
      { key: "none", ids: [3] },
    ]);
    expect(buildRows(groups, (id) => id !== 1)).toEqual([
      { kind: "day", key: "2026-07-24", index: 0 },
      { kind: "item", id: 0 }, { kind: "item", id: 2 },
      { kind: "day", key: "none", index: 2 }, { kind: "item", id: 3 },
    ]);
  });
});
