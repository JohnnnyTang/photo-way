import { THEMES, type Theme } from "./model";

export type ResolvedTheme = Exclude<Theme, "auto">;

export const THEME_IDS: readonly Theme[] = THEMES;

/** Unknown id -> `auto` (DATA_CONTRACT 5). */
export function normalizeTheme(id: unknown): Theme {
  return typeof id === "string" && (THEMES as readonly string[]).includes(id) ? (id as Theme) : "auto";
}

export function resolveTheme(id: Theme, prefersDark: boolean): ResolvedTheme {
  return id === "auto" ? (prefersDark ? "dark" : "light") : id;
}

/** Colours the map needs as concrete strings; they come from the CSS custom properties of the active theme. */
export interface MapColors {
  bg: string;
  land: string;
  coast: string;
  lake: string;
  river: string;
  border: string;
  route: string;
  suspect: string;
  link: string;
  start: string;
  end: string;
  cluster: string;
  clusterInk: string;
  halo: string;
}

const VARS: Record<keyof MapColors, string> = {
  bg: "--pw-m-bg",
  land: "--pw-m-land",
  coast: "--pw-m-coast",
  lake: "--pw-m-lake",
  river: "--pw-m-river",
  border: "--pw-m-border",
  route: "--pw-route",
  suspect: "--pw-suspect",
  link: "--pw-link",
  start: "--pw-start",
  end: "--pw-end",
  cluster: "--pw-cluster",
  clusterInk: "--pw-cluster-ink",
  halo: "--pw-halo",
};

const FALLBACK: MapColors = {
  bg: "#cfe3ee",
  land: "#f3efe6",
  coast: "#9fb7c4",
  lake: "#cfe3ee",
  river: "#9cc3d8",
  border: "#a08c9e",
  route: "#d9480f",
  suspect: "#c92a2a",
  link: "#868e96",
  start: "#2f9e44",
  end: "#e03131",
  cluster: "#d9480f",
  clusterInk: "#ffffff",
  halo: "#ffffff",
};

export function readMapColors(root: Element): MapColors {
  const cs = getComputedStyle(root);
  const out = { ...FALLBACK };
  for (const k of Object.keys(VARS) as (keyof MapColors)[]) {
    const v = cs.getPropertyValue(VARS[k]).trim();
    if (v) out[k] = v;
  }
  return out;
}
