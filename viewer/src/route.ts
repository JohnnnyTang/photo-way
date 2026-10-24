import { dayKeyOf } from "./days";
import type { Item } from "./model";
import { haversineKm } from "./util";

export type SegmentKind = "normal" | "suspect" | "link";

export interface RouteRun {
  kind: SegmentKind;
  coords: [number, number][];
}

export interface RouteResult {
  runs: RouteRun[];
  distanceKm: number;
  start: Item | null;
  end: Item | null;
}

/**
 * Builds the travel path from map-visible, timestamped items (already in time order).
 * Consecutive legs of the same kind are merged into one polyline so direction arrows are spaced evenly.
 * `suspect` legs touch a suspect item; `link` legs jump between calendar days (flights, overnight moves).
 */
export function buildRoute(points: readonly Item[], suspects: ReadonlySet<number>): RouteResult {
  const runs: RouteRun[] = [];
  let distanceKm = 0;
  let cur: RouteRun | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const kind: SegmentKind = suspects.has(a.id) || suspects.has(b.id) ? "suspect" : dayKeyOf(a) !== dayKeyOf(b) ? "link" : "normal";
    if (kind !== "suspect") distanceKm += haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (!cur || cur.kind !== kind) {
      cur = { kind, coords: [[a.lon, a.lat]] };
      runs.push(cur);
    }
    cur.coords.push([b.lon, b.lat]);
  }
  return { runs, distanceKm, start: points[0] ?? null, end: points.length > 1 ? points[points.length - 1]! : null };
}
