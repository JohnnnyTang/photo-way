import type { FeatureCollection, Geometry } from "geojson";
import type { StyleSpecification, SourceSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import worldText from "../basemap/world.topo.json?raw";
import type { Basemap } from "./model";
import { T } from "./strings";
import type { MapColors } from "./themes";

export type BasemapId = Exclude<Basemap, "auto">;

export interface BasemapInfo {
  id: BasemapId;
  label: string;
  online: boolean;
  /** CSS gradient used for the swatch in the picker. */
  swatch: string;
}

export const BASEMAPS: readonly BasemapInfo[] = [
  { id: "offline", label: T.map.offline, online: false, swatch: "linear-gradient(135deg,#cfe3ee 0 45%,#f3efe6 45% 100%)" },
  { id: "satellite", label: T.map.satellite, online: true, swatch: "linear-gradient(135deg,#1d3b2a,#4d6b3d 55%,#7a6a4a)" },
  { id: "satellite-labels", label: T.map.satelliteLabels, online: true, swatch: "linear-gradient(135deg,#1d3b2a,#4d6b3d 55%,#7a6a4a)" },
  { id: "topo", label: T.map.topo, online: true, swatch: "linear-gradient(135deg,#d8e8c8,#e9dcb4 50%,#b8a37a)" },
  { id: "osm", label: T.map.osm, online: true, swatch: "linear-gradient(135deg,#aad3df,#f2efe9 50%,#f8d98a)" },
  { id: "terrain", label: T.map.terrain, online: true, swatch: "linear-gradient(135deg,#3b4a2c,#8b7d5a 50%,#d8d2c0)" },
];

export function resolveBasemap(pref: string | undefined, online: boolean): BasemapId {
  if (pref && BASEMAPS.some((b) => b.id === pref)) return pref as BasemapId;
  return online ? "satellite" : "offline";
}

const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

let worldCache: FeatureCollection | null = null;

/** Decodes the embedded Natural Earth TopoJSON once; every feature is tagged `{ k: land|lake|river|border }`. */
export function worldFeatures(): FeatureCollection {
  if (worldCache) return worldCache;
  const topo = JSON.parse(worldText) as Topology;
  const features: FeatureCollection["features"] = [];
  for (const k of Object.keys(topo.objects)) {
    const obj = topo.objects[k]!;
    const f = feature(topo, obj) as unknown as { type: string; geometry?: Geometry; features?: { geometry: Geometry }[] };
    const geoms = f.type === "FeatureCollection" ? (f.features ?? []).map((x) => x.geometry) : f.geometry ? [f.geometry] : [];
    for (const geometry of geoms) features.push({ type: "Feature", properties: { k }, geometry });
  }
  worldCache = { type: "FeatureCollection", features };
  return worldCache;
}

export interface StyleOptions {
  basemap: BasemapId;
  colors: MapColors;
  globe: boolean;
  exaggeration: number;
}

const rasterSource = (tiles: string[], attribution: string, maxzoom: number): SourceSpecification => ({
  type: "raster",
  tiles,
  tileSize: 256,
  maxzoom,
  attribution,
});

export function buildStyle(o: StyleOptions): StyleSpecification {
  const c = o.colors;
  const sources: Record<string, SourceSpecification> = {};
  const layers: LayerSpecification[] = [{ id: "bg", type: "background", paint: { "background-color": c.bg } }];
  const style: StyleSpecification = { version: 8, sources, layers };
  // No "glyphs" and no "sprite": the offline style must not fetch anything, so all text is HTML.

  if (o.basemap === "offline") {
    sources.ne = { type: "geojson", data: worldFeatures(), attribution: T.map.attribution.naturalEarth };
    const k = (name: string) => ["==", ["get", "k"], name] as never;
    layers.push(
      { id: "ne-land", type: "fill", source: "ne", filter: k("land"), paint: { "fill-color": c.land } },
      {
        id: "ne-coast",
        type: "line",
        source: "ne",
        filter: k("land"),
        paint: { "line-color": c.coast, "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 8, 1.4] },
      },
      { id: "ne-lake", type: "fill", source: "ne", filter: k("lake"), paint: { "fill-color": c.lake, "fill-outline-color": c.coast } },
      {
        id: "ne-river",
        type: "line",
        source: "ne",
        filter: k("river"),
        minzoom: 2,
        paint: { "line-color": c.river, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.4, 8, 1.6] },
      },
      {
        id: "ne-border",
        type: "line",
        source: "ne",
        filter: k("border"),
        paint: {
          "line-color": c.border,
          "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 8, 1.2],
          "line-dasharray": [3, 2],
        },
      },
    );
  } else if (o.basemap === "satellite" || o.basemap === "satellite-labels" || o.basemap === "terrain") {
    sources.imagery = rasterSource([ESRI_IMAGERY], T.map.attribution.esri, 19);
    layers.push({ id: "imagery", type: "raster", source: "imagery" });
    if (o.basemap === "satellite-labels") {
      sources.labels = rasterSource([ESRI_LABELS], T.map.attribution.esriLabels, 19);
      layers.push({ id: "labels", type: "raster", source: "labels" });
    }
  } else if (o.basemap === "topo") {
    sources.topo = rasterSource(
      ["a", "b", "c"].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      T.map.attribution.opentopo,
      17,
    );
    layers.push({ id: "topo", type: "raster", source: "topo" });
  } else {
    sources.osm = rasterSource(["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], T.map.attribution.osm, 19);
    layers.push({ id: "osm", type: "raster", source: "osm" });
  }

  if (o.basemap === "terrain") {
    // Two sources with the same tiles, as in MapLibre's own 3D-terrain example (S2 section 3).
    const dem = { type: "raster-dem" as const, tiles: [TERRARIUM], encoding: "terrarium" as const, tileSize: 256, maxzoom: 15 };
    sources.hillshadeDem = { ...dem, attribution: T.map.attribution.terrain };
    sources.terrainDem = { ...dem };
    layers.push({
      id: "hillshade",
      type: "hillshade",
      source: "hillshadeDem",
      paint: { "hillshade-exaggeration": 0.4, "hillshade-shadow-color": "#2b2a27" },
    });
    style.terrain = { source: "terrainDem", exaggeration: o.exaggeration };
  }
  if (o.globe) style.projection = { type: "globe" };
  return style;
}

/** Re-colours the offline vector layers in place (theme change without reloading the style). */
export function offlinePaint(c: MapColors): [layer: string, prop: string, value: string][] {
  return [
    ["bg", "background-color", c.bg],
    ["ne-land", "fill-color", c.land],
    ["ne-coast", "line-color", c.coast],
    ["ne-lake", "fill-color", c.lake],
    ["ne-lake", "fill-outline-color", c.coast],
    ["ne-river", "line-color", c.river],
    ["ne-border", "line-color", c.border],
  ];
}
