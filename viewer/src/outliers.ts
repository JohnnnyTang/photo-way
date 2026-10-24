import { haversineKm } from "./util";

export interface GeoPoint {
  id: number;
  lat: number;
  lon: number;
  ts: number | null;
}

export const DEFAULT_OUTLIER_KMH = 300;

/**
 * Port of the legacy template's `computeSuspects`: flags GPS spikes by speed between
 * consecutive (time-ordered) items. A run of 1 fast segment flags both ends, a run of 2
 * flags the middle item, a run of 3 or more is treated as genuine fast travel (flight, train).
 * Items without a capture time are never flagged.
 */
export function computeSuspects(items: readonly GeoPoint[], thresholdKmh: number = DEFAULT_OUTLIER_KMH): Set<number> {
  const suspects = new Set<number>();
  const geo = items
    .filter((d): d is GeoPoint & { ts: number } => d.ts != null && isFinite(d.lat) && isFinite(d.lon))
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
  if (geo.length < 3) return suspects;

  const fast: boolean[] = [];
  for (let i = 0; i < geo.length - 1; i++) {
    const a = geo[i]!;
    const b = geo[i + 1]!;
    const dtSec = (b.ts - a.ts) / 1000;
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    // A large distance within the same second is abnormal; otherwise check speed.
    const speed = dtSec > 1 ? (km / dtSec) * 3600 : km > 0.5 ? Infinity : 0;
    fast.push(speed > thresholdKmh);
  }

  let i = 0;
  while (i < fast.length) {
    if (!fast[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < fast.length && fast[j]) j++;
    const run = j - i;
    if (run === 1) {
      suspects.add(geo[i]!.id);
      suspects.add(geo[i + 1]!.id);
    } else if (run === 2) {
      suspects.add(geo[i + 1]!.id);
    }
    i = j;
  }
  return suspects;
}
