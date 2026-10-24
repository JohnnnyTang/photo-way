import { sortByTime } from "./days";
import type { Item } from "./model";

/**
 * Where each timestamped item sits in the whole trip. It ignores filters, the chosen day and hidden
 * items, so a stop keeps its number and colour whatever is shown.
 */
export interface TripOrder {
  /** 1-based stop number by item id; items without a capture time have none. */
  number: Map<number, number>;
  /** Item ids from the first stop to the last. */
  ids: number[];
  count: number;
}

export function tripOrder(items: readonly Item[]): TripOrder {
  const ids = sortByTime(items.filter((i) => i.ts != null)).map((it) => it.id);
  return { number: new Map(ids.map((id, k) => [id, k + 1])), ids, count: ids.length };
}

/** 0 at the first stop of the trip, 1 at the last; `null` without a capture time. */
export function tripT(order: TripOrder, id: number): number | null {
  const n = order.number.get(id);
  if (n == null) return null;
  return order.count > 1 ? (n - 1) / (order.count - 1) : 0;
}

// ---- time ramp ----------------------------------------------------------------------------------
// Trip order is ordinal, so it gets one hue from light (first stop) to dark (last stop), never a
// rainbow. The hue is the theme's route colour; lightness is spaced evenly in OKLCH. A dark map
// surface gets its own, lighter steps so the last stops do not sink into it.

export const RAMP_STEPS = 9;
const L_RANGE = { light: [0.82, 0.38], dark: [0.94, 0.56] } as const;
const FALLBACK_HUE = 45; // the default route orange

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function parseHex(color: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const s = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as Rgb;
}

function toHex(rgb: Rgb): string {
  return "#" + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("");
}

/** sRGB (0..1) to OKLCH (L 0..1, C, h in degrees). */
export function oklch(rgb: Rgb): { l: number; c: number; h: number } {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** OKLCH to linear sRGB; components may fall outside 0..1 when out of gamut. */
function oklchToLinear(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** The most saturated in-gamut colour at this lightness and hue, up to `maxC`. */
function inGamut(L: number, maxC: number, h: number): string {
  const fits = (c: number) => oklchToLinear(L, c, h).every((v) => v >= -0.0005 && v <= 1.0005);
  let lo = 0;
  let hi = maxC;
  if (!fits(hi)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
  } else lo = hi;
  return toHex(oklchToLinear(L, lo, h).map(toGamma) as Rgb);
}

/** `RAMP_STEPS` colours from the first stop (light) to the last (dark), in the hue of `routeColor`. */
export function timeRamp(routeColor: string, darkSurface = false): string[] {
  const [first, last] = L_RANGE[darkSurface ? "dark" : "light"];
  const rgb = parseHex(routeColor);
  const base = rgb ? oklch(rgb) : null;
  const hue = base && base.c > 0.03 ? base.h : FALLBACK_HUE;
  const maxC = Math.max(0.12, Math.min(0.2, base?.c ?? 0.17));
  return Array.from({ length: RAMP_STEPS }, (_, i) => inGamut(first + ((last - first) * i) / (RAMP_STEPS - 1), maxC, hue));
}

/** Colour at `t` (0..1), interpolated between ramp steps in sRGB like MapLibre's `interpolate`. */
export function rampAt(ramp: readonly string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const a = parseHex(ramp[i]!)!;
  const b = parseHex(ramp[i + 1]!)!;
  const f = x - i;
  return toHex(a.map((v, k) => v + (b[k]! - v) * f) as Rgb);
}

/** True for a dark hex colour (OKLCH lightness below one half); false when it cannot be read. */
export function isDark(color: string): boolean {
  const rgb = parseHex(color);
  return !!rgb && oklch(rgb).l < 0.5;
}

/** Readable ink (dark or white) for text on `color`. */
export function inkOn(color: string): string {
  const rgb = parseHex(color);
  return rgb && oklch(rgb).l > 0.68 ? "#16191d" : "#ffffff";
}

/** MapLibre expression: the ramp colour for the numeric property `prop` (0..1). */
export function rampExpression(ramp: readonly string[], prop = "t"): unknown[] {
  const stops: unknown[] = [];
  ramp.forEach((c, i) => stops.push(i / (ramp.length - 1), c));
  return ["interpolate", ["linear"], ["coalesce", ["get", prop], 0], ...stops];
}
