// Typed wrappers over the Tauri commands and events (see app/src-tauri/src/commands.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppLanguage, Locale } from "../../../shared/locale";

export type Phase = "import" | "scan" | "process" | "export";
export interface PhotosImportRequest {
  source: "selection" | "range";
  startDay: string | null;
  endDay: string | null;
  favoritesOnly: boolean;
  locationOnly: boolean;
}
export interface PhotosImportResult { count: number; path?: string }
export type FullSize = "none" | "web" | "original";
export type FormatId = "html" | "dir" | "zip";

export interface Settings {
  title: string;
  full: FullSize;
  webEdge: number;
  includeVideo: boolean;
  stripExif: boolean;
  coordDecimals: number | null;
  basemap: string;
  theme: string;
  format: FormatId;
  language: AppLanguage;
  /** Null in settings saved before Wave 4; resolved from app language on first use. */
  exportLanguage: Locale | null;
}

export interface SkipGroup {
  reason: string;
  label: string;
  count: number;
  files: string[];
}

export interface Summary {
  found: number;
  withLocation: number;
  photos: number;
  videos: number;
  live: number;
  firstDay: string | null;
  lastDay: string | null;
  skipped: SkipGroup[];
  pendingPosters: number[];
}

export interface Estimates {
  html: number;
  dir: number;
  zip: number;
}

export interface Built {
  version: number;
  items: number;
  estimates: Estimates;
  errorCount?: number;
  errors?: { path: string; message: string }[];
}

export interface Exported {
  path: string;
  bytes: number;
}

export interface Progress {
  phase: Phase;
  done: number;
  total: number;
  label: string;
}

export interface Finished {
  phase: Phase;
  ok: boolean;
  cancelled: boolean;
  message?: string;
  code?: string;
  params?: Record<string, string | number>;
  data?: unknown;
}

export const api = {
  info: () => invoke<{ version: string; previewUrl: string; macos: boolean }>("app_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  setMenuLanguage: (language: Locale) => invoke<void>("set_menu_language", { language }),
  cancel: () => invoke<void>("cancel"),
  reset: () => invoke<void>("reset"),
  scan: (paths: string[], append: boolean) => invoke<void>("scan", { paths, append }),
  importPhotos: (request: PhotosImportRequest) => invoke<void>("import_photos", { request }),
  openPhotos: () => invoke<void>("open_photos"),
  setPoster: (index: number, bytes: Uint8Array) =>
    invoke<void>("set_poster", bytes, { headers: { index: String(index) } }),
  process: (settings: Settings) => invoke<void>("process", { settings }),
  refreshProject: (settings: Settings) => invoke<Built>("refresh_project", { settings }),
  exportTo: (format: FormatId, out: string, settings: Settings) =>
    invoke<void>("export", { format, out, settings }),
  openInBrowser: (path: string) => invoke<void>("open_in_browser", { path }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  serveStart: (path: string) => invoke<string>("serve_start", { path }),
  serveStop: () => invoke<void>("serve_stop"),
};

export function onProgress(fn: (p: Progress) => void) {
  return listen<Progress>("pw-progress", (e) => fn(e.payload));
}

export function onFinished(fn: (f: Finished) => void) {
  return listen<Finished>("pw-finished", (e) => fn(e.payload));
}

export function onMenu(fn: (id: string) => void) {
  return listen<string>("pw-menu", (e) => fn(e.payload));
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
