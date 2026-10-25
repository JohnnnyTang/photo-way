import type { Item, Project } from "./model";
import { viewerLanguageKey, type Locale } from "../../shared/locale";

export interface Fix {
  lat: number;
  lon: number;
}

export interface Edits {
  v: 1;
  fixes: Record<number, Fix>;
  hidden: number[];
}

export interface Prefs {
  theme?: string;
  basemap?: string;
  terrainExaggeration?: number;
  /** Trip-order switches (see `RouteLook`). */
  routeTimeColor?: boolean;
  routeNumbers?: boolean;
  routeHighlight?: boolean;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const editsKey = (projectId: string) => `photoway:${projectId}:edits`;
export const PREFS_KEY = "photoway:prefs";

export function loadLanguage(projectId: string, storage: StorageLike | null = safeStorage()): Locale | null {
  try {
    const value = storage?.getItem(viewerLanguageKey(projectId));
    return value === "en" || value === "zh-CN" ? value : null;
  } catch { return null; }
}

export function saveLanguage(projectId: string, locale: Locale, storage: StorageLike | null = safeStorage()): boolean {
  try { storage?.setItem(viewerLanguageKey(projectId), locale); return !!storage; }
  catch { return false; }
}

export function safeStorage(): StorageLike | null {
  try {
    const s = window.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export const emptyEdits = (): Edits => ({ v: 1, fixes: {}, hidden: [] });

function validLat(n: unknown): n is number {
  return typeof n === "number" && isFinite(n) && n >= -90 && n <= 90;
}
function validLon(n: unknown): n is number {
  return typeof n === "number" && isFinite(n) && n >= -180 && n <= 180;
}

/** Sanitises untrusted stored data; drops entries for ids that are not in the project. */
export function sanitizeEdits(raw: unknown, itemCount: number): Edits {
  const out = emptyEdits();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { fixes?: unknown; hidden?: unknown };
  if (r.fixes && typeof r.fixes === "object") {
    for (const [k, v] of Object.entries(r.fixes as Record<string, unknown>)) {
      const id = Number(k);
      const f = v as Partial<Fix> | null;
      if (Number.isInteger(id) && id >= 0 && id < itemCount && f && validLat(f.lat) && validLon(f.lon)) {
        out.fixes[id] = { lat: f.lat, lon: f.lon };
      }
    }
  }
  if (Array.isArray(r.hidden)) {
    const seen = new Set<number>();
    for (const v of r.hidden) {
      if (Number.isInteger(v) && v >= 0 && v < itemCount && !seen.has(v)) {
        seen.add(v);
        out.hidden.push(v);
      }
    }
  }
  return out;
}

export function loadEdits(project: Pick<Project, "id" | "items">, storage: StorageLike | null = safeStorage()): Edits | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(editsKey(project.id));
    if (!text) return null;
    return sanitizeEdits(JSON.parse(text), project.items.length);
  } catch {
    return null;
  }
}

export function saveEdits(projectId: string, edits: Edits, storage: StorageLike | null = safeStorage(), keepEmpty = false): boolean {
  if (!storage) return false;
  try {
    const empty = !keepEmpty && !Object.keys(edits.fixes).length && !edits.hidden.length;
    if (empty) storage.removeItem(editsKey(projectId));
    else storage.setItem(editsKey(projectId), JSON.stringify(edits));
    return true;
  } catch {
    return false;
  }
}

export function loadPrefs(storage: StorageLike | null = safeStorage()): Prefs {
  if (!storage) return {};
  try {
    const raw = JSON.parse(storage.getItem(PREFS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return {};
    const p: Prefs = {};
    if (typeof raw.theme === "string") p.theme = raw.theme;
    if (typeof raw.basemap === "string") p.basemap = raw.basemap;
    if (typeof raw.terrainExaggeration === "number" && isFinite(raw.terrainExaggeration)) {
      p.terrainExaggeration = raw.terrainExaggeration;
    }
    for (const k of ["routeTimeColor", "routeNumbers", "routeHighlight"] as const) {
      if (typeof raw[k] === "boolean") p[k] = raw[k];
    }
    return p;
  } catch {
    return {};
  }
}

/** Merges into the shared prefs object (other keys written by other viewer versions are kept). */
export function savePrefs(patch: Prefs, storage: StorageLike | null = safeStorage()): boolean {
  if (!storage) return false;
  try {
    let current: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(storage.getItem(PREFS_KEY) ?? "null");
      if (parsed && typeof parsed === "object") current = parsed as Record<string, unknown>;
    } catch {
      /* ignore corrupt value */
    }
    storage.setItem(PREFS_KEY, JSON.stringify({ ...current, v: 1, ...patch }));
    return true;
  } catch {
    return false;
  }
}

export interface EffectiveState {
  items: Item[];
  fixed: Set<number>;
  hidden: Set<number>;
}

/**
 * Merges stored edits into the project's items. `hidden` starts from the items' own `"hidden"`
 * flags only when nothing has been stored yet (stored edits always hold the full hidden set).
 */
export function applyEdits(items: readonly Item[], edits: Edits | null): EffectiveState {
  const fixed = new Set<number>();
  const hidden = new Set<number>();
  const out = items.map((it) => {
    const flagged = it.flags?.includes("corrected") ?? false;
    if (flagged) fixed.add(it.id);
    if (!edits && it.flags?.includes("hidden")) hidden.add(it.id);
    const fix = edits?.fixes[it.id];
    if (fix) {
      fixed.add(it.id);
      return { ...it, lat: fix.lat, lon: fix.lon };
    }
    return it;
  });
  if (edits) for (const id of edits.hidden) hidden.add(id);
  return { items: out, fixed, hidden };
}

/** Builds the persistable form from live state, comparing against the pristine project items. */
export function collectEdits(pristine: readonly Item[], current: readonly Item[], hidden: ReadonlySet<number>): Edits {
  const edits = emptyEdits();
  for (let i = 0; i < pristine.length; i++) {
    const a = pristine[i]!;
    const b = current[i]!;
    if (a.lat !== b.lat || a.lon !== b.lon) edits.fixes[a.id] = { lat: b.lat, lon: b.lon };
  }
  edits.hidden = [...hidden].sort((x, y) => x - y);
  return edits;
}
