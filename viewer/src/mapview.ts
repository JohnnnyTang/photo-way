import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, Marker, MapGeoJSONFeature } from "maplibre-gl";
import workerSource from "virtual:maplibre-worker";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildStyle, offlinePaint, type BasemapId } from "./basemap";
import { dayKeyOf } from "./days";
import { h } from "./dom";
import type { Item } from "./model";
import type { PlayFrame } from "./play";
import type { RouteLeg, RouteResult, SegmentKind } from "./route";
import type { MapColors } from "./themes";
import { inkOn, isDark, rampAt, rampExpression, timeRamp } from "./trip";

// Never revoke: the worker pool re-creates workers when a map is created after all maps were removed.
// ".cjs" in the hash makes MapLibre start a classic (not module) worker, which works on file:// everywhere.
let workerReady = false;
function setupWorker(): void {
  if (workerReady) return;
  workerReady = true;
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  maplibregl.setWorkerUrl(url + "#maplibre-gl-worker.cjs");
}

export interface MapHost {
  thumbUrl(item: Item): string;
  item(id: number): Item | undefined;
  colors(): MapColors;
  onSelect(id: number): void;
  onOpen(id: number): void;
  onMoved(id: number, lat: number, lon: number): void;
  onOnlineFailed(): void;
  onOfflineZoomHint(show: boolean): void;
  /** 1-based place of the item in the whole trip, for numbered stops. */
  stopNumber(id: number): number | null;
  /** Place of the item in the whole trip, 0 (first) to 1 (last), for colour by time. */
  tripT(id: number): number | null;
  /** The pointer is over an item's pin or dot (`null` when it leaves). */
  onHover(id: number | null): void;
}

export interface MapState {
  basemap: BasemapId;
  globe: boolean;
  exaggeration: number;
}

/** How the map shows the order of the trip. Each part is a viewer switch. */
export interface RouteLook {
  /** Colour the route from light (first stop) to dark (last stop) instead of one route colour. */
  timeColor: boolean;
  /** Stop numbers on pins, dots and cluster ranges. */
  numbers: boolean;
  /** Hovered or selected items light up their legs; other days stay faint around a chosen day. */
  highlight: boolean;
}

export const DEFAULT_LOOK: RouteLook = { timeColor: true, numbers: false, highlight: true };

/** The whole trip's route, drawn faintly around a chosen `day`. */
export interface RouteContext {
  route: RouteResult;
  day: string;
}

const THUMB_ZOOM = 11;
const MAX_THUMBS = 150;
const MAX_LEAF_NUMBERS = 250;
const CLUSTER_MAX_ZOOM = 14;
const SRC_ITEMS = "pw-items";
const SRC_ROUTE = "pw-route";
const SRC_ENDS = "pw-ends";
const SRC_PLAY = "pw-play";
const SRC_FOCUS = "pw-focus";
const ARROW = "pw-arrow";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** Layers drawn from route legs; playback and focus change their filters and opacity together. */
const LEG_LAYERS: { id: string; kinds: SegmentKind[]; opacity: number }[] = [
  { id: "pw-route-casing", kinds: ["normal", "link"], opacity: 0.85 },
  { id: "pw-route-line", kinds: ["normal"], opacity: 1 },
  { id: "pw-route-link", kinds: ["link"], opacity: 1 },
  { id: "pw-route-suspect", kinds: ["suspect"], opacity: 1 },
];

/** Consecutive legs share one polyline while their colour stays within one of this many steps. */
const COLOR_STEPS = 48;
const IMAGERY: ReadonlySet<BasemapId> = new Set(["satellite", "satellite-labels", "terrain"]);

/**
 * The time ramp for what the route sits on: imagery gets a white casing (a light surface), vector
 * maps the theme halo. The timeline uses the same ramp so its stripes match the map.
 */
export function routeRamp(colors: MapColors, basemap: BasemapId): string[] {
  return timeRamp(colors.route, !IMAGERY.has(basemap) && isDark(colors.halo));
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function clusterRadius(count: number): number {
  return count >= 1000 ? 31 : count >= 100 ? 25 : count >= 10 ? 20 : 16;
}

/** `#4` or `#4–9` (the lowest to highest stop number in a cluster). */
function rangeLabel(lo: number, hi: number): string {
  return lo === hi ? `#${lo}` : `#${lo}${String.fromCharCode(0x2013)}${hi}`;
}

/** White chevrons with a dark rim read on every route colour and basemap. */
function arrowImage(): ImageData {
  const size = 48;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.lineJoin = "round";
  g.lineWidth = 5;
  g.strokeStyle = "rgba(0, 0, 0, 0.55)";
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(40, 24);
  g.lineTo(13, 10);
  g.lineTo(20, 24);
  g.lineTo(13, 38);
  g.closePath();
  g.stroke();
  g.fill();
  return g.getImageData(0, 0, size, size);
}

function compactCount(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export class MapView {
  readonly map: MlMap;
  private overlayReady = false;
  private items: Item[] = [];
  private route: RouteResult | null = null;
  private context: RouteContext | null = null;
  private showRoute = true;
  private look: RouteLook = { ...DEFAULT_LOOK };
  private ramp: string[];
  private hoverId: number | null = null;
  private play: PlayFrame | null = null;
  private legCounts = { legs: 0, faint: 0, features: 0 };
  /** For each leg of the shown route, the first leg of the run it is drawn in (playback). */
  private runStart: number[] = [];
  /** Bumped on every data push, so the focus source knows when its legs may have moved. */
  private routeVersion = 0;
  private focusKey = "";
  private selected: Item | null = null;
  private colors: MapColors;
  private state: MapState;
  private clusterMarkers = new Map<number, Marker>();
  private thumbMarkers = new Map<number, Marker>();
  private leafMarkers = new Map<number, Marker>();
  private selMarker: Marker | null = null;
  private selId = -1;
  private raf = 0;
  private dragSuppress = false;
  private onlineFail = 0;
  private onlineOk = 0;
  private failReported = false;
  private destroyed = false;

  constructor(
    container: HTMLElement,
    private host: MapHost,
    state: MapState,
  ) {
    setupWorker();
    this.state = { ...state };
    this.colors = host.colors();
    this.ramp = routeRamp(this.colors, this.state.basemap);
    this.map = new maplibregl.Map({
      container,
      style: buildStyle({ ...this.state, colors: this.colors }),
      center: [20, 25],
      zoom: 1.4,
      maxPitch: 80,
      attributionControl: { compact: true },
      fadeDuration: 120,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    this.map.on("error", (e) => this.onMapError(e as unknown as { sourceId?: string }));
    this.map.on("sourcedata", (e) => {
      if (e.sourceId === SRC_ITEMS) this.schedule();
      else if (e.sourceId && e.tile && this.isOnlineSource(e.sourceId)) this.onlineOk++;
    });
    this.map.on("move", () => this.schedule(150));
    this.map.on("moveend", () => this.schedule());
    this.map.on("zoomend", () => this.host.onOfflineZoomHint(this.state.basemap === "offline" && this.map.getZoom() >= 7));
    this.map.on("style.load", () => this.installOverlay());
    if (this.map.isStyleLoaded()) this.installOverlay();
  }

  /** The overlay (data layers) must be re-created after every `setStyle`. */
  private installOverlay(): void {
    if (this.destroyed || this.map.getSource(SRC_ITEMS)) return;
    const m = this.map;
    const c = this.colors;
    this.focusKey = ""; // the new focus source starts empty
    this.onlineFail = 0;
    this.onlineOk = 0;
    this.failReported = false;
    if (!m.hasImage(ARROW)) m.addImage(ARROW, arrowImage(), { pixelRatio: 2 });

    m.addSource(SRC_ROUTE, { type: "geojson", data: EMPTY });
    m.addSource(SRC_ENDS, { type: "geojson", data: EMPTY });
    m.addSource(SRC_PLAY, { type: "geojson", data: EMPTY });
    m.addSource(SRC_FOCUS, { type: "geojson", data: EMPTY });
    m.addSource(SRC_ITEMS, {
      type: "geojson",
      data: EMPTY,
      cluster: true,
      clusterRadius: 52,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
      // Lowest and highest stop number per cluster, for numbered stops.
      clusterProperties: {
        nmin: ["min", ["coalesce", ["get", "n"], 1e9]],
        nmax: ["max", ["coalesce", ["get", "n"], -1]],
      } as never,
    });

    const width = (a: number, b: number) => ["interpolate", ["linear"], ["zoom"], 3, a, 14, b] as never;
    const round = { "line-cap": "round", "line-join": "round" } as const;
    const color = this.lineColor();
    const casing = this.casingColor();
    const casingW = width(5.5, 10);
    const lineW = width(2.6, 5);
    const lineLayer = (id: string, paint: Record<string, unknown>, layout: Record<string, unknown> = round) => {
      const spec = LEG_LAYERS.find((l) => l.id === id)!;
      m.addLayer({ id, type: "line", source: SRC_ROUTE, filter: this.legFilter(spec.kinds), layout, paint: { ...paint, "line-opacity": this.legOpacity(spec.opacity) } } as never);
    };
    // A solid casing under every leg (dashed day links included) keeps the route readable on imagery.
    lineLayer("pw-route-casing", { "line-color": casing, "line-width": casingW });
    lineLayer("pw-route-line", { "line-color": color, "line-width": lineW });
    lineLayer("pw-route-link", { "line-color": color, "line-width": lineW, "line-dasharray": [1.6, 1.3] }, { "line-cap": "butt", "line-join": "round" });
    lineLayer("pw-route-suspect", { "line-color": c.suspect, "line-width": width(1.8, 3.2), "line-dasharray": [2, 2] }, { "line-cap": "butt" });
    // The focused item's legs, drawn wider on top.
    const focusLine = (kinds: SegmentKind[]) => ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "kind"], ["literal", kinds]]] as never;
    m.addLayer({ id: "pw-focus-casing", type: "line", source: SRC_FOCUS, filter: focusLine(["normal", "link"]), layout: round, paint: { "line-color": casing, "line-width": width(8.5, 14) } });
    m.addLayer({ id: "pw-focus-line", type: "line", source: SRC_FOCUS, filter: focusLine(["normal"]), layout: round, paint: { "line-color": color, "line-width": width(4.5, 8) } });
    m.addLayer({ id: "pw-focus-link", type: "line", source: SRC_FOCUS, filter: focusLine(["link"]), layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": color, "line-width": width(4.5, 8), "line-dasharray": [1.6, 1.3] } });
    // Playback: the leg being travelled, up to the moving head.
    const playLine = ["==", ["geometry-type"], "LineString"] as never;
    m.addLayer({ id: "pw-play-casing", type: "line", source: SRC_PLAY, filter: playLine, layout: round, paint: { "line-color": casing, "line-width": casingW, "line-opacity": 0.85 } });
    m.addLayer({ id: "pw-play-line", type: "line", source: SRC_PLAY, filter: playLine, layout: round, paint: { "line-color": color as never, "line-width": lineW } });
    m.addLayer({
      id: "pw-route-arrows",
      type: "symbol",
      source: SRC_ROUTE,
      filter: ["in", ["get", "kind"], ["literal", ["normal", "link"]]] as never,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 110,
        "icon-image": ARROW,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 14, 0.8] as never,
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": false,
        "icon-ignore-placement": false,
        visibility: this.play ? "none" : "visible",
      },
      paint: { "icon-opacity": this.legOpacity(1) as never },
    });
    m.addLayer({
      id: "pw-ends",
      type: "circle",
      source: SRC_ENDS,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5, 14, 9] as never,
        "circle-color": ["match", ["get", "role"], "start", c.start, c.end] as never,
        "circle-stroke-color": c.halo,
        "circle-stroke-width": 2.5,
      },
    });
    m.addLayer({
      id: "pw-focus-ring",
      type: "circle",
      source: SRC_FOCUS,
      filter: ["==", ["geometry-type"], "Point"] as never,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 10, 14, 16] as never,
        "circle-color": "rgba(0, 0, 0, 0)",
        "circle-stroke-color": color as never,
        "circle-stroke-width": 3.5,
      },
    });
    m.addLayer({
      id: "pw-play-head",
      type: "circle",
      source: SRC_PLAY,
      filter: ["==", ["geometry-type"], "Point"] as never,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 6, 14, 9] as never,
        "circle-color": color as never,
        "circle-stroke-color": c.halo,
        "circle-stroke-width": 3,
      },
    });
    m.addLayer({
      id: "pw-clusters",
      type: "circle",
      source: SRC_ITEMS,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": c.cluster,
        "circle-opacity": 0.92,
        "circle-stroke-color": c.halo,
        "circle-stroke-width": 3,
        "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 100, 25, 1000, 31] as never,
      },
    });
    m.addLayer({
      id: "pw-leaves",
      type: "circle",
      source: SRC_ITEMS,
      filter: ["!", ["has", "point_count"]],
      paint: { "circle-radius": 5.5, "circle-color": c.cluster, "circle-stroke-color": c.halo, "circle-stroke-width": 2 },
    });

    m.on("click", "pw-clusters", (e) => this.onClusterClick(e.features?.[0]));
    m.on("click", "pw-leaves", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "number") this.host.onSelect(id);
    });
    for (const l of ["pw-clusters", "pw-leaves"]) {
      m.on("mouseenter", l, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", l, () => (m.getCanvas().style.cursor = ""));
    }
    m.on("mousemove", "pw-leaves", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "number" && id !== this.hoverId) this.host.onHover(id);
    });
    m.on("mouseleave", "pw-leaves", () => this.host.onHover(null));
    this.overlayReady = true;
    this.pushData();
    this.schedule();
  }

  // ---- route look (colour by time, focus, playback) ---------------------------------------------

  private lineColor(): never {
    return (this.look.timeColor ? rampExpression(this.ramp) : this.colors.route) as never;
  }

  /** The item whose legs light up: the hovered one, else the selected one; none while playing. */
  private focusId(): number | null {
    if (!this.look.highlight || this.play) return null;
    return this.hoverId ?? (this.selId >= 0 ? this.selId : null);
  }

  private legFilter(kinds: SegmentKind[]): never {
    const f: unknown[] = ["all", ["in", ["get", "kind"], ["literal", kinds]]];
    // While playing, only runs already travelled: their last leg (index in the played route) is below `k`.
    if (this.play) f.push([">=", ["get", "p0"], 0], ["<", ["get", "p1"], this.play.k]);
    return f as never;
  }

  /** Imagery is dark and busy, so the route sits on a white casing there; elsewhere on the theme halo. */
  private casingColor(): string {
    return IMAGERY.has(this.state.basemap) ? "#ffffff" : this.colors.halo;
  }

  /** Context legs (other days) stay faint; with a focus, the route steps back (its legs are redrawn on top). */
  private legOpacity(base: number): never {
    const faint = ["==", ["get", "dim"], 1];
    if (this.focusId() == null) return ["case", faint, base * 0.3, base] as never;
    const rest = this.hoverId != null ? 0.35 : 0.6;
    return ["case", faint, base * 0.2, base * rest] as never;
  }

  private applyFocus(): void {
    const m = this.map;
    if (!this.overlayReady) return;
    for (const l of LEG_LAYERS) if (m.getLayer(l.id)) m.setPaintProperty(l.id, "line-opacity", this.legOpacity(l.opacity));
    if (m.getLayer("pw-route-arrows")) m.setPaintProperty("pw-route-arrows", "icon-opacity", this.legOpacity(1));
    // The focused item's legs and a ring around it live in their own small source.
    const id = this.focusId();
    const it = id == null ? undefined : this.host.item(id);
    // Every refresh passes through here; skip the worker round trip when nothing changed.
    const key = it ? [it.id, it.lon, it.lat, this.routeVersion, this.showRoute].join(",") : "";
    if (key === this.focusKey) return;
    this.focusKey = key;
    const features: GeoJSON.Feature[] = [];
    if (it) {
      const legs = this.showRoute ? ((this.context?.route ?? this.route)?.legs ?? []) : [];
      for (const l of legs) {
        if ((l.a === it.id || l.b === it.id) && l.kind !== "suspect") {
          features.push({ type: "Feature", properties: { kind: l.kind, t: this.legT(l) }, geometry: { type: "LineString", coordinates: l.coords } });
        }
      }
      features.push({ type: "Feature", properties: { t: this.host.tripT(it.id) }, geometry: { type: "Point", coordinates: [it.lon, it.lat] } });
    }
    (m.getSource(SRC_FOCUS) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
  }

  setLook(look: RouteLook): void {
    const numbersChanged = look.numbers !== this.look.numbers || (look.numbers && look.timeColor !== this.look.timeColor);
    const timeChanged = look.timeColor !== this.look.timeColor;
    this.look = { ...look };
    if (!this.overlayReady) return;
    this.applyColors();
    if (timeChanged) this.pushData(); // runs are split by colour step only when colouring by time
    else this.applyFocus();
    if (numbersChanged) this.resetMarkers();
  }

  private applyColors(): void {
    const m = this.map;
    const color = this.lineColor();
    for (const l of ["pw-route-line", "pw-route-link", "pw-focus-line", "pw-focus-link", "pw-play-line"]) if (m.getLayer(l)) m.setPaintProperty(l, "line-color", color);
    if (m.getLayer("pw-focus-ring")) m.setPaintProperty("pw-focus-ring", "circle-stroke-color", color);
    if (m.getLayer("pw-play-head")) m.setPaintProperty("pw-play-head", "circle-color", color);
  }

  setHover(id: number | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.applyFocus();
  }

  /** Draws the trip up to a playback frame, or the whole route again with `null`. */
  setPlay(frame: PlayFrame | null): void {
    const was = this.play;
    this.play = frame;
    const m = this.map;
    if (!this.overlayReady) return;
    if (!was || !frame || was.k !== frame.k) {
      for (const l of LEG_LAYERS) if (m.getLayer(l.id)) m.setFilter(l.id, this.legFilter(l.kinds));
    }
    if (!was !== !frame) {
      if (m.getLayer("pw-route-arrows")) m.setLayoutProperty("pw-route-arrows", "visibility", frame ? "none" : "visible");
      this.applyFocus();
    }
    const leg = frame ? this.route?.legs[frame.k] : undefined;
    const t = leg ? this.legT(leg) : 0;
    // The run being travelled is hidden by the filter; draw it from its first stop up to the head.
    const pts = this.route?.points ?? [];
    const start = frame ? (this.runStart[frame.k] ?? frame.k) : 0;
    const travelled = frame ? [...pts.slice(start, frame.k + 1).map((q) => [q.lon, q.lat] as [number, number]), frame.head] : [];
    (m.getSource(SRC_PLAY) as GeoJSONSource | undefined)?.setData(
      frame
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: { t }, geometry: { type: "LineString", coordinates: travelled } },
              { type: "Feature", properties: { t }, geometry: { type: "Point", coordinates: frame.head } },
            ],
          }
        : EMPTY,
    );
  }

  private legT(leg: RouteLeg): number {
    const a = this.host.tripT(leg.a);
    const b = this.host.tripT(leg.b);
    return a != null && b != null ? (a + b) / 2 : (a ?? b ?? 0);
  }

  /** Colour of an item in the current look, for HTML badges. */
  private itemColor(id: number): string {
    const t = this.look.timeColor ? this.host.tripT(id) : null;
    return t == null ? this.colors.route : rampAt(this.ramp, t);
  }

  /** Keeps a moving item in view without re-centring on every step. */
  follow(it: Item): void {
    const c = this.map.getContainer();
    const p = this.map.project([it.lon, it.lat]);
    const mx = c.clientWidth * 0.18;
    const my = c.clientHeight * 0.18;
    if (p.x < mx || p.y < my || p.x > c.clientWidth - mx || p.y > c.clientHeight - my) {
      this.map.easeTo({ center: [it.lon, it.lat], duration: reducedMotion() ? 0 : 600 });
    }
  }

  private onClusterClick(f: MapGeoJSONFeature | undefined): void {
    const id = f?.properties?.cluster_id;
    if (!f || typeof id !== "number") return;
    const src = this.map.getSource(SRC_ITEMS) as GeoJSONSource | undefined;
    const center = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    void src?.getClusterExpansionZoom(id).then((z) => {
      this.map.easeTo({ center, zoom: Math.min(z + 0.3, 18), duration: reducedMotion() ? 0 : 500 });
    });
  }

  private isOnlineSource(id: string): boolean {
    return id === "imagery" || id === "labels" || id === "topo" || id === "osm";
  }

  private onMapError(e: { sourceId?: string }): void {
    // Tile failures are expected when offline. They must never reach console.error.
    if (e.sourceId && this.isOnlineSource(e.sourceId)) {
      this.onlineFail++;
      if (!this.failReported && this.onlineFail >= 4 && this.onlineOk === 0) {
        this.failReported = true;
        this.host.onOnlineFailed();
      }
    }
  }

  // ---- data -------------------------------------------------------------------------------------

  setItems(items: Item[]): void {
    this.items = items;
    this.pushData();
  }

  /** `context` draws the whole trip faintly around the chosen day; `route` is what is shown and played. */
  setRoute(route: RouteResult, show: boolean, context: RouteContext | null = null): void {
    this.route = route;
    this.showRoute = show;
    this.context = context;
    this.pushData();
  }

  private pushData(): void {
    if (!this.overlayReady) return;
    const m = this.map;
    const items = m.getSource(SRC_ITEMS) as GeoJSONSource | undefined;
    items?.setData({
      type: "FeatureCollection",
      features: this.items.map((it) => ({
        type: "Feature",
        id: it.id,
        properties: { id: it.id, kind: it.kind, n: this.host.stopNumber(it.id) },
        geometry: { type: "Point", coordinates: [it.lon, it.lat] },
      })),
    });
    const routeSrc = m.getSource(SRC_ROUTE) as GeoJSONSource | undefined;
    const endsSrc = m.getSource(SRC_ENDS) as GeoJSONSource | undefined;
    const r = this.route;
    this.routeVersion++;
    if (r && this.showRoute) {
      const ctx = this.context;
      // `p`: the leg's index in the shown route (playback order); -1 for context-only legs.
      const shown = new Map(r.legs.map((l) => [`${l.a}>${l.b}`, l.i]));
      const dayOf = (id: number) => {
        const it = this.host.item(id);
        return it ? dayKeyOf(it) : "";
      };
      const legs = (ctx?.route ?? r).legs.map((l) => ({
        leg: l,
        p: ctx ? (shown.get(`${l.a}>${l.b}`) ?? -1) : l.i,
        dim: ctx && !(dayOf(l.a) === ctx.day && dayOf(l.b) === ctx.day) ? 1 : 0,
      }));
      // Merge consecutive legs into runs while kind, faintness and colour step agree: a few dozen
      // polylines draw far faster than one feature per leg, and arrows stay evenly spaced along them.
      // `p0`..`p1` is the run's range of leg indexes in the shown route (playback), -1 for context.
      const timed = this.look.timeColor;
      const runs: { kind: SegmentKind; dim: number; p0: number; p1: number; step: number; tSum: number; n: number; coords: [number, number][] }[] = [];
      for (const { leg, p, dim } of legs) {
        const t = this.legT(leg);
        const step = timed ? Math.min(COLOR_STEPS - 1, Math.floor(t * COLOR_STEPS)) : 0;
        const last = runs[runs.length - 1];
        const next = last && (p < 0 ? last.p1 < 0 : last.p1 >= 0 && p === last.p1 + 1);
        if (last && next && last.kind === leg.kind && last.dim === dim && last.step === step) {
          last.coords.push(leg.coords[1]);
          last.p1 = p;
          last.tSum += t;
          last.n++;
        } else runs.push({ kind: leg.kind, dim, p0: p, p1: p, step, tSum: t, n: 1, coords: [leg.coords[0], leg.coords[1]] });
      }
      this.runStart = [];
      for (const run of runs) if (run.p0 >= 0) for (let q = run.p0; q <= run.p1; q++) this.runStart[q] = run.p0;
      this.legCounts = { legs: legs.length, faint: legs.filter((l) => l.dim).length, features: runs.length };
      routeSrc?.setData({
        type: "FeatureCollection",
        features: runs.map((run) => ({
          type: "Feature",
          properties: { kind: run.kind, dim: run.dim, p0: run.p0, p1: run.p1, t: run.tSum / run.n },
          geometry: { type: "LineString", coordinates: run.coords },
        })),
      });
      const ends: GeoJSON.Feature[] = [];
      if (r.start) ends.push({ type: "Feature", properties: { role: "start" }, geometry: { type: "Point", coordinates: [r.start.lon, r.start.lat] } });
      if (r.end) ends.push({ type: "Feature", properties: { role: "end" }, geometry: { type: "Point", coordinates: [r.end.lon, r.end.lat] } });
      endsSrc?.setData({ type: "FeatureCollection", features: ends });
    } else {
      this.legCounts = { legs: 0, faint: 0, features: 0 };
      this.runStart = [];
      routeSrc?.setData(EMPTY);
      endsSrc?.setData(EMPTY);
    }
    this.applyFocus();
    this.schedule();
  }

  // ---- markers (HTML cluster counts, thumbnail pins, selection) ----------------------------------

  private schedule(delay = 0): void {
    if (this.destroyed || this.raf) return;
    const wait = Math.max(delay, 0);
    this.raf = window.setTimeout(() => {
      this.raf = 0;
      this.updateMarkers();
    }, wait);
  }

  private updateMarkers(): void {
    const m = this.map;
    if (!this.overlayReady || !m.getLayer("pw-clusters")) return;
    // 1) cluster counts (and the range of stop numbers inside, when numbering is on)
    const seen = new Set<number>();
    for (const f of m.queryRenderedFeatures({ layers: ["pw-clusters"] })) {
      const id = f.properties?.cluster_id as number | undefined;
      if (typeof id !== "number" || seen.has(id)) continue;
      seen.add(id);
      const points = Number(f.properties?.point_count ?? 0);
      const count = compactCount(points);
      const lo = Number(f.properties?.nmin);
      const hi = Number(f.properties?.nmax);
      const range = this.look.numbers && lo <= hi ? rangeLabel(lo, hi) : "";
      const key = `${count}|${range}`;
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const fill = (el: HTMLElement) => {
        el.dataset.k = key;
        el.replaceChildren(count);
        if (range) el.append(h("span", { class: "pw-cluster-range", style: `top:${clusterRadius(points) + 6}px` }, range));
      };
      const marker = this.clusterMarkers.get(id);
      if (marker) {
        // Supercluster may reuse an id after setData. Keep the HTML label and position in sync.
        if (marker.getElement().dataset.k !== key) fill(marker.getElement());
        const p = marker.getLngLat();
        if (p.lng !== lon || p.lat !== lat) marker.setLngLat([lon, lat]);
      } else {
        const el = h("div", { class: "pw-cluster-count" });
        fill(el);
        this.clusterMarkers.set(id, new maplibregl.Marker({ element: el, pitchAlignment: "viewport", rotationAlignment: "viewport" }).setLngLat([lon, lat]).addTo(m));
      }
    }
    for (const [id, mk] of this.clusterMarkers) {
      if (!seen.has(id)) {
        mk.remove();
        this.clusterMarkers.delete(id);
      }
    }
    // 2) thumbnail pins for unclustered leaves, only when zoomed in
    const want = new Set<number>();
    if (m.getZoom() >= THUMB_ZOOM) {
      const c = m.getCenter();
      const leaves: { id: number; d: number }[] = [];
      const dup = new Set<number>();
      for (const f of m.queryRenderedFeatures({ layers: ["pw-leaves"] })) {
        const id = f.properties?.id as number | undefined;
        if (typeof id !== "number" || dup.has(id) || id === this.selId) continue;
        dup.add(id);
        const it = this.host.item(id);
        if (it) leaves.push({ id, d: (it.lon - c.lng) ** 2 + (it.lat - c.lat) ** 2 });
      }
      leaves.sort((a, b) => a.d - b.d);
      for (const l of leaves.slice(0, MAX_THUMBS)) want.add(l.id);
    }
    for (const [id, mk] of this.thumbMarkers) {
      if (!want.has(id)) {
        mk.remove();
        this.thumbMarkers.delete(id);
      }
    }
    for (const id of want) {
      const it = this.host.item(id);
      if (!it) continue;
      const existing = this.thumbMarkers.get(id);
      if (existing) {
        const p = existing.getLngLat();
        if (p.lng !== it.lon || p.lat !== it.lat) existing.setLngLat([it.lon, it.lat]);
        continue;
      }
      this.thumbMarkers.set(id, this.makePin(it, false));
    }
    // hide dots under pins is unnecessary: pins cover them
    // 3) stop numbers over plain dots (zoomed out, or beyond the thumbnail limit)
    const nums = new Set<number>();
    if (this.look.numbers) {
      const c = m.getCenter();
      const leaves: { id: number; d: number }[] = [];
      for (const f of m.queryRenderedFeatures({ layers: ["pw-leaves"] })) {
        const id = f.properties?.id as number | undefined;
        if (typeof id !== "number" || nums.has(id) || want.has(id) || id === this.selId || this.host.stopNumber(id) == null) continue;
        nums.add(id);
        const it = this.host.item(id);
        if (it) leaves.push({ id, d: (it.lon - c.lng) ** 2 + (it.lat - c.lat) ** 2 });
      }
      nums.clear();
      leaves.sort((a, b) => a.d - b.d);
      for (const l of leaves.slice(0, MAX_LEAF_NUMBERS)) nums.add(l.id);
    }
    for (const [id, mk] of this.leafMarkers) {
      if (!nums.has(id)) {
        mk.remove();
        this.leafMarkers.delete(id);
      }
    }
    for (const id of nums) {
      const it = this.host.item(id);
      if (!it) continue;
      const existing = this.leafMarkers.get(id);
      if (existing) {
        const p = existing.getLngLat();
        if (p.lng !== it.lon || p.lat !== it.lat) existing.setLngLat([it.lon, it.lat]);
        continue;
      }
      const el = this.numberBadge(id, "pw-leafnum");
      if (el) this.leafMarkers.set(id, new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -7], pitchAlignment: "viewport", rotationAlignment: "viewport" }).setLngLat([it.lon, it.lat]).addTo(m));
    }
  }

  private numberBadge(id: number, cls: string): HTMLElement | null {
    const n = this.host.stopNumber(id);
    if (n == null) return null;
    const bg = this.itemColor(id);
    return h("span", { class: cls, style: `background:${bg};color:${inkOn(bg)}` }, String(n));
  }

  /** Re-creates every HTML marker, e.g. after the numbering or colouring changed. */
  private resetMarkers(): void {
    for (const mk of this.clusterMarkers.values()) mk.remove();
    for (const mk of this.thumbMarkers.values()) mk.remove();
    for (const mk of this.leafMarkers.values()) mk.remove();
    this.clusterMarkers.clear();
    this.thumbMarkers.clear();
    this.leafMarkers.clear();
    const sel = this.selected;
    this.selMarker?.remove();
    this.selMarker = null;
    this.selId = -1;
    this.setSelected(sel);
  }

  private makePin(it: Item, selected: boolean): Marker {
    const img = h("img", { alt: "", decoding: "async", draggable: false });
    img.src = this.host.thumbUrl(it);
    const el = h("div", { class: `pw-pin${selected ? " is-selected" : ""}${it.kind !== "photo" ? " is-" + it.kind : ""}` }, img);
    if (this.look.numbers) {
      const badge = this.numberBadge(it.id, "pw-pin-num");
      if (badge) el.append(badge);
    }
    el.addEventListener("mouseenter", () => this.host.onHover(it.id));
    el.addEventListener("mouseleave", () => this.host.onHover(null));
    const mk = new maplibregl.Marker({ element: el, anchor: "bottom", draggable: true, pitchAlignment: "viewport", rotationAlignment: "viewport" })
      .setLngLat([it.lon, it.lat])
      .addTo(this.map);
    mk.on("dragstart", () => {
      this.dragSuppress = true;
      el.classList.add("is-dragging");
    });
    mk.on("dragend", () => {
      el.classList.remove("is-dragging");
      const p = mk.getLngLat();
      setTimeout(() => (this.dragSuppress = false), 60);
      this.host.onMoved(it.id, p.lat, p.lng);
    });
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (this.dragSuppress) return;
      this.host.onSelect(it.id);
      this.host.onOpen(it.id);
    });
    return mk;
  }

  setSelected(item: Item | null): void {
    this.selected = item;
    const id = item?.id ?? -1;
    if (this.selMarker && this.selId === id) {
      if (item) this.selMarker.setLngLat([item.lon, item.lat]);
      return;
    }
    this.selMarker?.remove();
    this.selMarker = null;
    this.selId = id;
    if (item) {
      const stale = this.thumbMarkers.get(item.id);
      if (stale) {
        stale.remove();
        this.thumbMarkers.delete(item.id);
      }
      this.selMarker = this.makePin(item, true);
    }
    this.applyFocus();
    this.schedule();
  }

  // ---- camera ---------------------------------------------------------------------------------

  fit(items: readonly Item[], opts: { maxZoom?: number; animate?: boolean } = {}): void {
    const pts = items.length ? items : this.items;
    if (!pts.length) return;
    const b = new maplibregl.LngLatBounds([pts[0]!.lon, pts[0]!.lat], [pts[0]!.lon, pts[0]!.lat]);
    for (const p of pts) b.extend([p.lon, p.lat]);
    const duration = opts.animate === false || reducedMotion() ? 0 : 800;
    this.map.fitBounds(b, { padding: { top: 70, bottom: 60, left: 50, right: 60 }, maxZoom: opts.maxZoom ?? 15, duration });
  }

  flyTo(it: Item, minZoom = 12.5): void {
    this.map.easeTo({ center: [it.lon, it.lat], zoom: Math.max(this.map.getZoom(), minZoom), duration: reducedMotion() ? 0 : 700 });
  }

  // ---- style / theme ----------------------------------------------------------------------------

  setBasemap(basemap: BasemapId, exaggeration: number): void {
    const was = this.state.basemap;
    this.state = { ...this.state, basemap, exaggeration };
    this.ramp = routeRamp(this.colors, basemap);
    if (was === basemap) {
      this.applyTerrain();
      return;
    }
    this.rebuildStyle();
    if (basemap === "terrain") this.map.easeTo({ pitch: Math.max(this.map.getPitch(), 55), duration: reducedMotion() ? 0 : 800 });
    else if (was === "terrain") this.map.easeTo({ pitch: 0, bearing: 0, duration: reducedMotion() ? 0 : 600 });
    this.host.onOfflineZoomHint(basemap === "offline" && this.map.getZoom() >= 7);
  }

  setExaggeration(v: number): void {
    this.state = { ...this.state, exaggeration: v };
    this.applyTerrain();
  }

  private applyTerrain(): void {
    if (this.state.basemap === "terrain" && this.map.getSource("terrainDem")) {
      this.map.setTerrain({ source: "terrainDem", exaggeration: this.state.exaggeration });
    }
  }

  setGlobe(globe: boolean): void {
    this.state = { ...this.state, globe };
    this.map.setProjection({ type: globe ? "globe" : "mercator" });
  }

  private rebuildStyle(): void {
    this.overlayReady = false;
    for (const mk of this.clusterMarkers.values()) mk.remove();
    for (const mk of this.thumbMarkers.values()) mk.remove();
    for (const mk of this.leafMarkers.values()) mk.remove();
    this.clusterMarkers.clear();
    this.thumbMarkers.clear();
    this.leafMarkers.clear();
    this.map.setStyle(buildStyle({ ...this.state, colors: this.colors }), { diff: false });
  }

  /** Theme change: recolour in place, no style reload. */
  setColors(colors: MapColors): void {
    const hueChanged = colors.route !== this.colors.route;
    this.colors = colors;
    this.ramp = routeRamp(colors, this.state.basemap);
    const m = this.map;
    if (!this.overlayReady) return;
    this.applyColors();
    if (hueChanged && this.look.numbers) this.resetMarkers();
    const set = (layer: string, prop: string, value: unknown) => {
      if (m.getLayer(layer)) m.setPaintProperty(layer, prop as never, value as never);
    };
    if (this.state.basemap === "offline") for (const [l, p, v] of offlinePaint(colors)) set(l, p, v);
    else set("bg", "background-color", colors.bg);
    for (const l of ["pw-route-casing", "pw-focus-casing", "pw-play-casing"]) set(l, "line-color", this.casingColor());
    set("pw-play-head", "circle-stroke-color", colors.halo);
    set("pw-route-suspect", "line-color", colors.suspect);
    set("pw-ends", "circle-color", ["match", ["get", "role"], "start", colors.start, colors.end]);
    set("pw-ends", "circle-stroke-color", colors.halo);
    set("pw-clusters", "circle-color", colors.cluster);
    set("pw-clusters", "circle-stroke-color", colors.halo);
    set("pw-leaves", "circle-color", colors.cluster);
    set("pw-leaves", "circle-stroke-color", colors.halo);
  }

  resize(): void {
    this.map.resize();
  }

  /** Counts for diagnostics and tests. */
  stats() {
    const m = this.map;
    return {
      clusters: this.clusterMarkers.size,
      pins: this.thumbMarkers.size + (this.selMarker ? 1 : 0),
      zoom: m.getZoom(),
      basemap: this.state.basemap,
      hasRoute: !!m.getLayer("pw-route-line"),
      loaded: this.overlayReady && m.loaded(),
      look: { ...this.look },
      legs: this.legCounts.legs,
      faintLegs: this.legCounts.faint,
      routeFeatures: this.legCounts.features,
      leafNumbers: this.leafMarkers.size,
      focus: this.focusId(),
      playing: this.play ? this.play.k : null,
      ramp: [...this.ramp],
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) clearTimeout(this.raf);
    for (const mk of this.clusterMarkers.values()) mk.remove();
    for (const mk of this.thumbMarkers.values()) mk.remove();
    for (const mk of this.leafMarkers.values()) mk.remove();
    this.selMarker?.remove();
    this.map.remove();
  }
}
