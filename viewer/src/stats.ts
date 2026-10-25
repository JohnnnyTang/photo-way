import { dayKeyOf } from "./days";
import type { Item } from "./model";
import { legKind } from "./route";
import { viewerStrings } from "./catalog";
import { formatKm, haversineKm } from "./util";
import type { Locale } from "../../shared/locale";

/** Altitude changes smaller than this are noise (photo altitudes jitter by several metres) and are not counted. */
export const ELEVATION_STEP_M = 10;

export interface Elevation {
  gain: number;
  loss: number;
  min: number;
  max: number;
}

export interface DayStat {
  key: string;
  /** Items on the route. */
  count: number;
  /** Km along the route inside the day. The leg that jumps to another day is in neither day. */
  distanceKm: number;
  /** First to last capture time in ms, `null` with fewer than two different timestamps. */
  spanMs: number | null;
  /** `null` unless at least two of the items carry an altitude. */
  elevation: Elevation | null;
}

export interface TripStats {
  days: Map<string, DayStat>;
  total: DayStat;
}

interface Acc {
  stat: DayStat;
  firstTs: number | null;
  lastTs: number | null;
  /** Altitude readings seen, and the last altitude that was counted. */
  alts: number;
  anchor: number;
  gain: number;
  loss: number;
  min: number;
  max: number;
}

const newAcc = (key: string): Acc => ({
  stat: { key, count: 0, distanceKm: 0, spanMs: null, elevation: null },
  firstTs: null,
  lastTs: null,
  alts: 0,
  anchor: 0,
  gain: 0,
  loss: 0,
  min: Infinity,
  max: -Infinity,
});

function feed(acc: Acc, it: Item, suspect: boolean): void {
  acc.stat.count++;
  if (it.ts != null) {
    acc.firstTs ??= it.ts;
    acc.lastTs = it.ts;
  }
  const alt = it.alt;
  if (alt == null || !isFinite(alt) || suspect) return;
  acc.min = Math.min(acc.min, alt);
  acc.max = Math.max(acc.max, alt);
  if (acc.alts++ === 0) acc.anchor = alt;
  else if (Math.abs(alt - acc.anchor) >= ELEVATION_STEP_M) {
    if (alt > acc.anchor) acc.gain += alt - acc.anchor;
    else acc.loss += acc.anchor - alt;
    acc.anchor = alt;
  }
}

function finish(acc: Acc): DayStat {
  const s = acc.stat;
  s.spanMs = acc.firstTs != null && acc.lastTs != null && acc.lastTs > acc.firstTs ? acc.lastTs - acc.firstTs : null;
  s.elevation = acc.alts >= 2 ? { gain: acc.gain, loss: acc.loss, min: acc.min, max: acc.max } : null;
  return s;
}

/**
 * Per-day and whole-trip numbers from the points the route passes through (time-ordered and map-visible, so hidden
 * items, the outlier filter and drag-corrected positions are already applied, exactly as the route draws them).
 * One pass, O(n).
 *
 * Distance: the haversine sum over consecutive points, skipping legs that touch a suspect, like the route's own
 * total. A leg between two days (a flight, an overnight move) is not counted in either day, but the trip total
 * does include it, so the total equals `buildRoute(...).distanceKm`.
 *
 * Elevation: hysteresis. A change only counts once the altitude has moved at least `ELEVATION_STEP_M` from the last
 * counted altitude, so jitter never adds up. Suspect items are ignored. min/max are the raw extremes. The trip
 * total is the sum of the days' gain and loss (no climbing is invented across a gap between days).
 */
export function computeTripStats(points: readonly Item[], suspects: ReadonlySet<number>): TripStats {
  const accs = new Map<string, Acc>();
  const total = newAcc("trip");
  let totalKm = 0;
  for (let i = 0; i < points.length; i++) {
    const b = points[i]!;
    const key = dayKeyOf(b);
    let acc = accs.get(key);
    if (!acc) accs.set(key, (acc = newAcc(key)));
    feed(acc, b, suspects.has(b.id));
    total.stat.count++;
    const a = points[i - 1];
    if (a && legKind(a, b, suspects) !== "suspect") {
      const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
      totalKm += km;
      if (dayKeyOf(a) === key) acc.stat.distanceKm += km;
    }
  }
  const days = new Map<string, DayStat>();
  let withElev = false;
  for (const [key, acc] of accs) {
    days.set(key, finish(acc));
    total.firstTs = Math.min(total.firstTs ?? Infinity, acc.firstTs ?? Infinity);
    total.lastTs = Math.max(total.lastTs ?? -Infinity, acc.lastTs ?? -Infinity);
    if (acc.alts >= 2) {
      withElev = true;
      total.gain += acc.gain;
      total.loss += acc.loss;
      total.min = Math.min(total.min, acc.min);
      total.max = Math.max(total.max, acc.max);
    }
  }
  total.alts = withElev ? 2 : 0;
  const t = finish(total);
  if (!isFinite(total.firstTs ?? NaN) || !isFinite(total.lastTs ?? NaN)) t.spanMs = null;
  t.distanceKm = totalKm;
  return { days, total: t };
}

/** "12 min", "7 h 12 min", "3 h", and from a day on "3 d 14 h". */
export function formatSpan(ms: number, locale: Locale = "en"): string {
  const min = Math.round(ms / 60_000);
  if (locale === "zh-CN") {
    if (min < 60) return `${Math.max(1, min)} 分钟`;
    if (min >= 24 * 60) {
      const h = Math.round(min / 60);
      const d = Math.floor(h / 24);
      return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
    }
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  if (min < 60) return `${Math.max(1, min)} min`;
  if (min >= 24 * 60) {
    const h = Math.round(min / 60);
    const d = Math.floor(h / 24);
    return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
  }
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "42.3 km · ↑ 610 m ↓ 580 m · 7 h 12 min"; whatever is unknown (or zero distance) is left out. */
export function formatStat(s: DayStat | undefined, withSpan = true, locale: Locale = "en"): string {
  if (!s) return "";
  const parts: string[] = [];
  if (s.distanceKm > 0) parts.push(formatKm(s.distanceKm, locale));
  if (s.elevation) parts.push(viewerStrings(locale).stats.elevation(Math.round(s.elevation.gain), Math.round(s.elevation.loss)));
  if (withSpan && s.spanMs != null) parts.push(formatSpan(s.spanMs, locale));
  return parts.join(" · ");
}
