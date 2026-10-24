import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, Marker, MapGeoJSONFeature } from "maplibre-gl";
import workerSource from "virtual:maplibre-worker";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildStyle, offlinePaint, type BasemapId } from "./basemap";
import { h } from "./dom";
import type { Item } from "./model";
import type { RouteResult } from "./route";
import type { MapColors } from "./themes";

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
}

export interface MapState {
  basemap: BasemapId;
  globe: boolean;
  exaggeration: number;
}

const THUMB_ZOOM = 11;
const MAX_THUMBS = 150;
const CLUSTER_MAX_ZOOM = 14;
const SRC_ITEMS = "pw-items";
const SRC_ROUTE = "pw-route";
const SRC_ENDS = "pw-ends";
const ARROW = "pw-arrow";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function arrowImage(color: string, halo: string): ImageData {
  const size = 48;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.lineJoin = "round";
  g.lineWidth = 5;
  g.strokeStyle = halo;
  g.fillStyle = color;
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
  private showRoute = true;
  private selected: Item | null = null;
  private colors: MapColors;
  private state: MapState;
  private clusterMarkers = new Map<number, Marker>();
  private thumbMarkers = new Map<number, Marker>();
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
    this.onlineFail = 0;
    this.onlineOk = 0;
    this.failReported = false;
    if (!m.hasImage(ARROW)) m.addImage(ARROW, arrowImage(c.route, c.halo), { pixelRatio: 2 });

    m.addSource(SRC_ROUTE, { type: "geojson", data: EMPTY });
    m.addSource(SRC_ENDS, { type: "geojson", data: EMPTY });
    m.addSource(SRC_ITEMS, { type: "geojson", data: EMPTY, cluster: true, clusterRadius: 52, clusterMaxZoom: CLUSTER_MAX_ZOOM });

    const kind = (k: string) => ["==", ["get", "kind"], k] as never;
    const width = (a: number, b: number) => ["interpolate", ["linear"], ["zoom"], 3, a, 14, b] as never;
    m.addLayer({
      id: "pw-route-casing",
      type: "line",
      source: SRC_ROUTE,
      filter: kind("normal"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.halo, "line-width": width(4.5, 8), "line-opacity": 0.8 },
    });
    m.addLayer({
      id: "pw-route-line",
      type: "line",
      source: SRC_ROUTE,
      filter: kind("normal"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.route, "line-width": width(2.2, 4.2) },
    });
    m.addLayer({
      id: "pw-route-link",
      type: "line",
      source: SRC_ROUTE,
      filter: kind("link"),
      layout: { "line-cap": "butt" },
      paint: { "line-color": c.link, "line-width": width(1.6, 3), "line-dasharray": [1, 2.2] },
    });
    m.addLayer({
      id: "pw-route-suspect",
      type: "line",
      source: SRC_ROUTE,
      filter: kind("suspect"),
      layout: { "line-cap": "butt" },
      paint: { "line-color": c.suspect, "line-width": width(1.6, 3), "line-dasharray": [2, 2] },
    });
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
      },
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
    this.overlayReady = true;
    this.pushData();
    this.schedule();
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

  setRoute(route: RouteResult, show: boolean): void {
    this.route = route;
    this.showRoute = show;
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
        properties: { id: it.id, kind: it.kind },
        geometry: { type: "Point", coordinates: [it.lon, it.lat] },
      })),
    });
    const routeSrc = m.getSource(SRC_ROUTE) as GeoJSONSource | undefined;
    const endsSrc = m.getSource(SRC_ENDS) as GeoJSONSource | undefined;
    const r = this.route;
    if (r && this.showRoute) {
      routeSrc?.setData({
        type: "FeatureCollection",
        features: r.runs.map((run) => ({ type: "Feature", properties: { kind: run.kind }, geometry: { type: "LineString", coordinates: run.coords } })),
      });
      const ends: GeoJSON.Feature[] = [];
      if (r.start) ends.push({ type: "Feature", properties: { role: "start" }, geometry: { type: "Point", coordinates: [r.start.lon, r.start.lat] } });
      if (r.end) ends.push({ type: "Feature", properties: { role: "end" }, geometry: { type: "Point", coordinates: [r.end.lon, r.end.lat] } });
      endsSrc?.setData({ type: "FeatureCollection", features: ends });
    } else {
      routeSrc?.setData(EMPTY);
      endsSrc?.setData(EMPTY);
    }
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
    // 1) cluster counts
    const seen = new Set<number>();
    for (const f of m.queryRenderedFeatures({ layers: ["pw-clusters"] })) {
      const id = f.properties?.cluster_id as number | undefined;
      if (typeof id !== "number" || seen.has(id)) continue;
      seen.add(id);
      const count = compactCount(Number(f.properties?.point_count ?? 0));
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const marker = this.clusterMarkers.get(id);
      if (marker) {
        // Supercluster may reuse an id after setData. Keep the HTML label and position in sync.
        if (marker.getElement().textContent !== count) marker.getElement().textContent = count;
        const p = marker.getLngLat();
        if (p.lng !== lon || p.lat !== lat) marker.setLngLat([lon, lat]);
      } else {
        const el = h("div", { class: "pw-cluster-count" }, count);
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
  }

  private makePin(it: Item, selected: boolean): Marker {
    const img = h("img", { alt: "", decoding: "async", draggable: false });
    img.src = this.host.thumbUrl(it);
    const el = h("div", { class: `pw-pin${selected ? " is-selected" : ""}${it.kind !== "photo" ? " is-" + it.kind : ""}` }, img);
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
    this.clusterMarkers.clear();
    this.thumbMarkers.clear();
    this.map.setStyle(buildStyle({ ...this.state, colors: this.colors }), { diff: false });
  }

  /** Theme change: recolour in place, no style reload. */
  setColors(colors: MapColors): void {
    this.colors = colors;
    const m = this.map;
    if (!this.overlayReady) return;
    const set = (layer: string, prop: string, value: unknown) => {
      if (m.getLayer(layer)) m.setPaintProperty(layer, prop as never, value as never);
    };
    if (this.state.basemap === "offline") for (const [l, p, v] of offlinePaint(colors)) set(l, p, v);
    else set("bg", "background-color", colors.bg);
    set("pw-route-casing", "line-color", colors.halo);
    set("pw-route-line", "line-color", colors.route);
    set("pw-route-link", "line-color", colors.link);
    set("pw-route-suspect", "line-color", colors.suspect);
    set("pw-ends", "circle-color", ["match", ["get", "role"], "start", colors.start, colors.end]);
    set("pw-ends", "circle-stroke-color", colors.halo);
    set("pw-clusters", "circle-color", colors.cluster);
    set("pw-clusters", "circle-stroke-color", colors.halo);
    set("pw-leaves", "circle-color", colors.cluster);
    set("pw-leaves", "circle-stroke-color", colors.halo);
    if (m.hasImage(ARROW)) m.removeImage(ARROW);
    m.addImage(ARROW, arrowImage(colors.route, colors.halo), { pixelRatio: 2 });
  }

  resize(): void {
    this.map.resize();
  }

  /** Counts for diagnostics and tests. */
  stats(): { clusters: number; pins: number; zoom: number; basemap: string; hasRoute: boolean; loaded: boolean } {
    const m = this.map;
    return {
      clusters: this.clusterMarkers.size,
      pins: this.thumbMarkers.size + (this.selMarker ? 1 : 0),
      zoom: m.getZoom(),
      basemap: this.state.basemap,
      hasRoute: !!m.getLayer("pw-route-line"),
      loaded: this.overlayReady && m.loaded(),
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) clearTimeout(this.raf);
    for (const mk of this.clusterMarkers.values()) mk.remove();
    for (const mk of this.thumbMarkers.values()) mk.remove();
    this.selMarker?.remove();
    this.map.remove();
  }
}
