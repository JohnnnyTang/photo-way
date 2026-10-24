const EARTH_RADIUS_KM = 6371;

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface DayParts {
  year: number;
  month: number; // 1-12
  day: number;
  monthName: string;
  weekday: string;
}

/** Parses `YYYY-MM-DD`. Returns null for anything else. */
export function parseDay(day: string | null | undefined): DayParts | null {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const d = Number(m[3]);
  if (month < 1 || month > 12) return null;
  const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
  return { year, month, day: d, monthName: MONTHS[month - 1] ?? "", weekday: WEEKDAYS[wd] ?? "" };
}

/** `HH:MM` exactly as written by the camera (no time-zone conversion). */
export function clockOf(time: string | null | undefined): string {
  const m = time ? /T(\d{2}):(\d{2})/.exec(time) : null;
  return m ? `${m[1]}:${m[2]}` : "";
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString("en-US")} km`;
}

export function formatCoord(lat: number, lon: number): string {
  const deg = String.fromCharCode(0xb0);
  return `${Math.abs(lat).toFixed(5)}${deg}${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(5)}${deg}${lon >= 0 ? "E" : "W"}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function uuid4(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
