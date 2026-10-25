// TS mirror of docs/DATA_CONTRACT.md (v1). Keep in sync with crates/core/src/model.rs.

export type Kind = "photo" | "video" | "live";
export type TsSource = "offset" | "gps" | "naive" | "file";
export type Basemap = "auto" | "offline" | "satellite" | "satellite-labels" | "topo" | "osm" | "terrain";
/** Relative URL or `#pack:<pack>:<offset>:<length>`. */
export type Ref = string;

export interface Item {
  id: number;
  kind: Kind;
  name: string;
  time: string | null;
  ts: number | null;
  tsSource: TsSource | null;
  day: string | null;
  lat: number;
  lon: number;
  alt?: number | null;
  w: number;
  h: number;
  dur?: number | null;
  thumb: Ref;
  full?: Ref | null;
  video?: Ref | null;
  flags?: string[];
}

export interface ProjectOptions {
  theme?: string;
  basemap?: Basemap;
  outlierSpeedKmh?: number;
  /** Absent in older exports. An unsupported explicit value falls back to English. */
  lang?: string;
}

export interface Project {
  format: "photoway";
  version: 1;
  id: string;
  title: string;
  generator: string;
  createdAt: string;
  options: ProjectOptions;
  items: Item[];
}

export const THEMES = ["auto", "light", "dark", "dusk", "paper", "forest"] as const;
export type Theme = (typeof THEMES)[number];
