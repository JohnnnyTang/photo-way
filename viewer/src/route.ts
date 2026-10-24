import { dayKeyOf } from "./days";
import type { Item } from "./model";
import { haversineKm } from "./util";

export type SegmentKind = "normal" | "suspect" | "link";

export interface RouteRun {
  kind: SegmentKind;
  coords: [number, number][];
}

/** One step between consecutive items: `a` and `b` are item ids, `i` its index in `legs`. */
export interface RouteLeg {
  kind: SegmentKind;
  a: number;
  b: number;
  i: number;
  coords: [[number, number], [number, number]];
}

export interface RouteResult {
  runs: RouteRun[];
  legs: RouteLeg[];
  /** The items the route passes through, in order. */
  points: Item[];
  distanceKm: number;
  start: Item | null;
  end: Item | null;
}

export const legKind = (a: Item, b: Item, suspects: ReadonlySet<number>): SegmentKind =>
  suspects.has(a.id) || suspects.has(b.id) ? "suspect" : dayKeyOf(a) !== dayKeyOf(b) ? "link" : "normal";

/**
 * Builds the travel path from map-visible, timestamped items (already in time order).
 * Consecutive legs of the same kind are merged into one polyline so direction arrows are spaced evenly.
 * `suspect` legs touch a suspect item; `link` legs jump between calendar days (flights, overnight moves).
 */
export function buildRoute(points: readonly Item[], suspects: ReadonlySet<number>): RouteResult {
  const runs: RouteRun[] = [];
  const legs: RouteLeg[] = [];
  let distanceKm = 0;
  let cur: RouteRun | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const kind = legKind(a, b, suspects);
    if (kind !== "suspect") distanceKm += haversineKm(a.lat, a.lon, b.lat, b.lon);
    legs.push({ kind, a: a.id, b: b.id, i, coords: [[a.lon, a.lat], [b.lon, b.lat]] });
    if (!cur || cur.kind !== kind) {
      cur = { kind, coords: [[a.lon, a.lat]] };
      runs.push(cur);
    }
    cur.coords.push([b.lon, b.lat]);
  }
  return { runs, legs, points: [...points], distanceKm, start: points[0] ?? null, end: points.length > 1 ? points[points.length - 1]! : null };
}
