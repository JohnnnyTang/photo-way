import { BASEMAPS, resolveBasemap, type BasemapId } from "./basemap";
import { resolveViewerLocale, type Locale } from "../../shared/locale";
import { viewerStrings } from "./catalog";
import { buildRows, dayKeyOf, groupByDay, NO_DAY, sortByTime, type DayGroup } from "./days";
import { createResolver, domPackReader, hasInlineData, type RefResolver } from "./data";
import { h, icon, ICONS } from "./dom";
import { DEFAULT_LOOK, MapView, routeRamp, type RouteContext, type RouteLook } from "./mapview";
import { Modal } from "./modal";
import type { Item, Kind, Project, Theme } from "./model";
import { computeSuspects, DEFAULT_OUTLIER_KMH } from "./outliers";
import { applyEdits, collectEdits, loadEdits, loadLanguage, loadPrefs, safeStorage, saveEdits, saveLanguage, savePrefs, type Edits } from "./persist";
import { Player } from "./play";
import { buildRoute, type RouteResult } from "./route";
import { computeTripStats, formatStat, type TripStats } from "./stats";
import { bakeProject, buildCorrections, downloadText, renderCopyHtml, safeFilename } from "./savecopy";
import { T, setViewerStrings } from "./strings";
import { normalizeTheme, readMapColors, resolveTheme, THEME_IDS } from "./themes";
import { Timeline, type DayState } from "./timeline";
import { rampAt, timeRamp, tripOrder, tripT, type TripOrder } from "./trip";
import { clamp, clockOf, formatCoord, formatViewerDay, parseDay } from "./util";

export interface MountOptions {
  mode?: "export" | "preview";
  resolveRef?: (ref: string) => string;
}

type TypeFilter = "all" | Kind;

const THEME_SWATCH: Record<Exclude<Theme, "auto">, [string, string, string]> = {
  light: ["#f7f5f0", "#ffffff", "#d9480f"],
  dark: ["#14181e", "#1f252d", "#ff922b"],
  dusk: ["#2a2140", "#3a2d57", "#ffd43b"],
  paper: ["#efe6d2", "#f8f1e0", "#9c2f1e"],
  forest: ["#14241c", "#1d3328", "#9be564"],
};

const DEFAULT_EXAGGERATION = 1.4;

export class App {
  private project!: Project;
  private pristine: Item[] = [];
  private items: Item[] = [];
  private hidden = new Set<number>();
  private suspects = new Set<number>();
  private groups: DayGroup[] = [];
  private groupOf = new Map<number, string>();

  private typeFilter: TypeFilter = "all";
  private showRoute = true;
  private hideOutliers = true;
  private dayKey: string | null = null;
  private selectedId: number | null = null;

  private themePref: Theme = "auto";
  private basemapPref: string = "auto";
  private basemap: BasemapId = "offline";
  private exaggeration = DEFAULT_EXAGGERATION;
  private globe = false;
  private offline = false;
  private storageOk = true;
  private locale: Locale = "en";

  private resolver: RefResolver;
  private resolveOverride: ((ref: string) => string) | undefined;
  private mq: MediaQueryList | null = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  private cleanups: (() => void)[] = [];

  private root: HTMLElement;
  private map: MapView | null = null;
  private timeline!: Timeline;
  private modal!: Modal;

  // dom parts
  private titleEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private cardEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private dayBtnLabel!: HTMLElement;
  private dayCountEl!: HTMLElement;
  private dayPanel!: HTMLElement;
  private dayEye!: HTMLButtonElement;
  private panels: { filters: HTMLElement; layers: HTMLElement; theme: HTMLElement; menu: HTMLElement } = null as never;
  private pops: { btn: HTMLElement; panel: HTMLElement }[] = [];
  private toastTimer = 0;
  private offlineHint = false;
  private tripStats: TripStats = computeTripStats([], new Set());

  // trip order: colour by time, numbered stops, highlight, playback
  private look: RouteLook = { ...DEFAULT_LOOK };
  private order: TripOrder = { number: new Map(), ids: [], count: 0 };
  private ramp: string[] = timeRamp("");
  private lastRoute: RouteResult | null = null;
  private player: Player;
  private playBtn!: HTMLButtonElement;
  private speedBtn!: HTMLButtonElement;
  private legendEl!: HTMLElement;

  constructor(
    private host: HTMLElement,
    project: Project,
    private opts: MountOptions,
  ) {
    this.locale = this.projectLocale(project);
    setViewerStrings(viewerStrings(this.locale));
    document.documentElement.lang = this.locale;
    this.resolveOverride = opts.resolveRef;
    this.resolver = createResolver(domPackReader(document));
    this.root = h("div", { class: "pw-root" });
    host.classList.add("pw-host");
    host.append(this.root);
    this.offline = typeof navigator !== "undefined" && navigator.onLine === false;
    this.player = new Player({
      points: () => this.lastRoute?.points ?? [],
      onFrame: (f) => this.map?.setPlay(f),
      onStop: (it) => {
        this.select(it.id, { scroll: true, byPlayer: true });
        this.map?.follow(it);
      },
      onState: () => this.refreshPlay(),
    });
    this.build();
    this.loadProject(project, true);
  }

  // ---- refs --------------------------------------------------------------------------------------

  private resolve = (ref: string, mime?: string): string => {
    if (!ref) return "";
    return this.resolveOverride ? this.resolveOverride(ref) : this.resolver.resolve(ref, mime);
  };

  // ---- data --------------------------------------------------------------------------------------

  private loadProject(project: Project, first: boolean): void {
    const nextLocale = this.projectLocale(project);
    if (nextLocale !== this.locale) this.setLanguage(nextLocale, false);
    this.project = project;
    this.pristine = project.items.map((i) => ({ ...i }));
    const storage = safeStorage();
    const stored = loadEdits(project, storage);
    const eff = applyEdits(this.pristine, stored);
    this.items = eff.items;
    this.hidden = eff.hidden;
    this.storageOk = this.probeStorage();
    this.groups = groupByDay(this.items);
    this.order = tripOrder(this.items);
    this.groupOf.clear();
    for (const g of this.groups) for (const id of g.ids) this.groupOf.set(id, g.key);
    this.dayKey = null;
    this.selectedId = null;
    this.typeFilter = "all";

    const prefs = loadPrefs(storage);
    if (first) {
      this.themePref = normalizeTheme(prefs.theme ?? project.options?.theme);
      this.basemapPref = prefs.basemap ?? project.options?.basemap ?? "auto";
      this.exaggeration = clamp(prefs.terrainExaggeration ?? DEFAULT_EXAGGERATION, 1, 3);
      this.look = {
        timeColor: prefs.routeTimeColor ?? DEFAULT_LOOK.timeColor,
        numbers: prefs.routeNumbers ?? DEFAULT_LOOK.numbers,
        highlight: prefs.routeHighlight ?? DEFAULT_LOOK.highlight,
      };
      this.basemap = this.pickBasemap(this.basemapPref);
    }
    this.titleEl.textContent = project.title || T.appName;
    document.title = project.title || T.appName;
    this.recomputeSuspects();
    this.applyTheme(false);
    if (first) this.createMap();
    this.refreshAll(true);
    this.map?.fit(this.mapItems(), { animate: false });
  }

  setProject(project: Project): void {
    this.modal.close();
    this.resolver.dispose();
    this.resolver = createResolver(domPackReader(document));
    this.loadProject(project, false);
    this.timeline.scrollToDay(this.groups[0]?.key ?? "", false);
  }

  private projectLocale(project: Project): Locale {
    return resolveViewerLocale(loadLanguage(project.id), project.options?.lang, typeof navigator === "undefined" ? "en" : navigator.language);
  }

  private setLanguage(locale: Locale, persist = true): void {
    if (locale === this.locale && persist) return;
    this.locale = locale;
    setViewerStrings(viewerStrings(locale));
    document.documentElement.lang = locale;
    if (persist) saveLanguage(this.project.id, locale);
    if (!this.timeline) return;
    this.closePops();
    const labels = [T.toolbar.filters, T.toolbar.layers, T.toolbar.theme, T.toolbar.menu, T.days.list];
    this.pops.forEach((pop, i) => {
      pop.btn.title = labels[i]!;
      pop.btn.setAttribute("aria-label", labels[i]!);
    });
    const tools = this.root.querySelectorAll<HTMLElement>(".pw-tool");
    [T.toolbar.fit, this.globe ? T.toolbar.flat : T.toolbar.globe].forEach((label, i) => {
      if (tools[i]) { tools[i].title = label; tools[i].setAttribute("aria-label", label); }
    });
    const nav = this.root.querySelectorAll<HTMLElement>(".pw-daybtn");
    [T.days.prev, T.days.next, T.days.toggle].forEach((label, i) => {
      if (nav[i]) { nav[i].title = label; nav[i].setAttribute("aria-label", label); }
    });
    this.root.querySelector<HTMLElement>(".pw-bottom")?.setAttribute("aria-label", T.timeline.label);
    this.legendEl.setAttribute("aria-label", T.legend.label);
    this.legendEl.title = T.legend.label;
    const noMap = this.root.querySelector<HTMLElement>(".pw-nomap");
    if (noMap) noMap.textContent = T.noWebgl;
    if (this.offlineHint) this.updateHintToast();
    const keepHidden = this.menuKeepHidden?.checked ?? false;
    for (const key of ["filters", "layers", "theme", "menu"] as const) {
      const previous = this.panels[key];
      const replacement = key === "filters" ? this.buildFiltersPanel() : key === "layers" ? this.buildLayersPanel() : key === "theme" ? this.buildThemePanel() : this.buildMenuPanel();
      previous.replaceWith(replacement);
      this.panels[key] = replacement;
      const pop = this.pops.find((p) => p.panel === previous);
      if (pop) pop.panel = replacement;
    }
    this.menuKeepHidden.checked = keepHidden;
    this.timeline.refreshLanguage();
    this.modal.refreshLanguage();
    this.refreshStats();
    this.refreshCard();
    this.refreshDayNav();
    this.refreshPanels();
    this.updateMenu();
    this.refreshPlay();
    this.refreshLegend();
  }

  private probeStorage(): boolean {
    const s = safeStorage();
    if (!s) return false;
    try {
      const k = "photoway:probe";
      s.setItem(k, "1");
      s.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  private pickBasemap(pref: string): BasemapId {
    const id = resolveBasemap(pref, !this.offline);
    return id === "terrain" && this.offline ? "offline" : id;
  }

  private recomputeSuspects(): void {
    this.suspects = computeSuspects(this.items, this.project.options?.outlierSpeedKmh ?? DEFAULT_OUTLIER_KMH);
  }

  private persist(): void {
    const edits = collectEdits(this.pristine, this.items, this.hidden);
    const keepEmpty = this.pristine.some((i) => i.flags?.includes("hidden"));
    this.storageOk = saveEdits(this.project.id, edits, safeStorage(), keepEmpty);
    this.updateMenu();
  }

  private currentEdits(): Edits {
    return collectEdits(this.pristine, this.items, this.hidden);
  }

  // ---- derived state -----------------------------------------------------------------------------

  private typeOk = (it: Item): boolean => this.typeFilter === "all" || it.kind === this.typeFilter;

  /** Shown on the map on any day (the chosen day is applied by `onMap`). */
  private onMapAnyDay = (it: Item): boolean => !this.hidden.has(it.id) && this.typeOk(it) && !(this.hideOutliers && this.suspects.has(it.id));

  private onMap = (it: Item): boolean => this.onMapAnyDay(it) && (this.dayKey == null || dayKeyOf(it) === this.dayKey);

  // ---- trip order ---------------------------------------------------------------------------------

  private tripT = (id: number): number | null => tripT(this.order, id);

  private itemColor = (id: number): string | null => {
    const t = this.look.timeColor ? this.tripT(id) : null;
    return t == null ? null : rampAt(this.ramp, t);
  };

  /** A day's colour is the ramp halfway between its first and last stop. */
  private dayColor = (key: string): string | null => {
    if (!this.look.timeColor) return null;
    const ts = (this.groups.find((g) => g.key === key)?.ids ?? []).map(this.tripT).filter((t): t is number => t != null);
    return ts.length ? rampAt(this.ramp, (Math.min(...ts) + Math.max(...ts)) / 2) : null;
  };

  private hover(id: number | null): void {
    this.map?.setHover(id);
    this.timeline.setHover(id);
  }

  private setLook(look: RouteLook): void {
    const contextChanged = look.highlight !== this.look.highlight;
    this.look = look;
    savePrefs({ routeTimeColor: look.timeColor, routeNumbers: look.numbers, routeHighlight: look.highlight });
    this.map?.setLook(look);
    if (contextChanged) this.refreshMap();
    else this.refreshLegend();
    this.timeline.refresh();
    this.refreshPanels();
  }

  private togglePlay(): void {
    if (this.player.state === "playing") this.player.pause();
    else if (this.player.play()) this.closePops();
  }

  private refreshPlay(): void {
    if (!this.playBtn) return;
    const st = this.player.state;
    const can = !!this.map && this.showRoute && (this.lastRoute?.points.length ?? 0) >= 2;
    this.playBtn.disabled = !can && st === "stopped";
    const label = st === "playing" ? T.play.pause : T.play.play;
    this.playBtn.title = label;
    this.playBtn.setAttribute("aria-label", label);
    this.playBtn.setAttribute("aria-pressed", String(st !== "stopped"));
    this.playBtn.replaceChildren(icon(st === "playing" ? ICONS.pause : ICONS.play, 18));
    this.speedBtn.hidden = st === "stopped";
    this.speedBtn.textContent = `${this.player.speed}x`;
    this.speedBtn.title = T.play.speed(this.player.speed);
    this.refreshCard();
  }

  /** Light-to-dark bar from the first photo's date to the last one's, with a tick where each day starts. */
  private refreshLegend(): void {
    if (!this.legendEl) return;
    const on = this.look.timeColor && this.showRoute && this.order.count >= 2 && !!this.map;
    this.legendEl.hidden = !on;
    if (!on) return;
    const first = this.items[this.order.ids[0]!]!;
    const last = this.items[this.order.ids[this.order.count - 1]!]!;
    const oneDay = dayKeyOf(first) === dayKeyOf(last);
    const label = (it: Item) => {
      const p = parseDay(dayKeyOf(it));
      return oneDay || !p ? clockOf(it.time) : formatViewerDay(dayKeyOf(it), this.locale, "short");
    };
    const ticks: HTMLElement[] = [];
    let prev = "";
    this.order.ids.forEach((id, k) => {
      const day = dayKeyOf(this.items[id]!);
      if (k > 0 && day !== prev && ticks.length < 60) ticks.push(h("i", { style: `left:${(100 * k) / (this.order.count - 1)}%` }));
      prev = day;
    });
    const bar = h("span", { class: "pw-legend-bar", style: `background:linear-gradient(90deg,${this.ramp.join(",")})` }, ...ticks);
    this.legendEl.replaceChildren(h("span", {}, label(first)), bar, h("span", {}, label(last)));
  }

  private mapItems(): Item[] {
    return this.items.filter(this.onMap);
  }

  private isEdited(id: number): boolean {
    const a = this.pristine[id];
    const b = this.items[id];
    return !!a && !!b && (a.lat !== b.lat || a.lon !== b.lon);
  }

  private groupIds(key: string): number[] {
    return (this.groups.find((g) => g.key === key)?.ids ?? []).filter((id) => {
      const it = this.items[id];
      return !!it && this.typeOk(it);
    });
  }

  private dayState = (key: string): DayState => {
    const ids = this.groupIds(key);
    const hid = ids.filter((id) => this.hidden.has(id)).length;
    return hid === 0 ? "all" : hid === ids.length ? "none" : "some";
  };

  private visibleDays(): DayGroup[] {
    return this.groups.filter((g) => this.groupIds(g.key).length > 0);
  }

  // ---- refresh -----------------------------------------------------------------------------------

  private refreshAll(rebuildRows: boolean): void {
    if (rebuildRows) this.rebuildRows();
    this.refreshMap();
    this.timeline.refresh();
    this.refreshStats();
    this.refreshCard();
    this.refreshDayNav();
    this.refreshPanels();
    this.updateMenu();
  }

  private rebuildRows(): void {
    this.timeline.setRows(buildRows(this.groups, (id) => this.typeOk(this.items[id]!)));
  }

  private refreshMap(): void {
    this.player.stop(); // anything that changes what is shown ends playback
    const items = this.mapItems();
    const pts = sortByTime(items.filter((i) => i.ts != null));
    const route = buildRoute(pts, this.suspects);
    this.lastRoute = route;
    // Around a chosen day, the rest of the trip stays on the map, faint, for context.
    let context: RouteContext | null = null;
    const all = this.dayKey ? sortByTime(this.items.filter((i) => i.ts != null && this.onMapAnyDay(i))) : pts;
    if (this.dayKey && this.look.highlight) context = { route: buildRoute(all, this.suspects), day: this.dayKey };
    this.tripStats = computeTripStats(all, this.suspects); // all days, whichever day is chosen
    this.map?.setItems(items);
    this.map?.setRoute(route, this.showRoute, context);
    this.refreshLegend();
    this.refreshPlay();
  }

  private refreshStats(): void {
    const total = this.items.length;
    const shown = this.mapItems().length;
    const dayCount = this.groups.filter((g) => g.key !== NO_DAY).length;
    const parts = [shown === total ? T.stats.items(total) : T.stats.shown(shown, total)];
    if (dayCount) parts.push(T.stats.days(dayCount));
    // The chosen day's numbers, or the whole trip's.
    const numbers = formatStat(this.dayKey ? this.tripStats.days.get(this.dayKey) : this.tripStats.total, true, this.locale);
    if (numbers) parts.push(numbers);
    if (this.suspects.size) parts.push(T.stats.outliers(this.suspects.size));
    this.statsEl.textContent = parts.join(" · ");
  }

  private refreshDayNav(): void {
    const g = this.dayKey ? this.groups.find((x) => x.key === this.dayKey) : null;
    const p = g ? parseDay(g.key) : null;
    this.dayBtnLabel.textContent = g ? (p ? formatViewerDay(g!.key, this.locale, "short") : T.days.none) : T.days.all;
    this.dayCountEl.textContent = g ? T.days.count(this.groupIds(g.key).length) : T.stats.items(this.items.filter(this.typeOk).length);
    const state = g ? this.dayState(g.key) : null;
    this.dayEye.disabled = !g;
    this.dayEye.dataset.state = state ?? "all";
    this.dayEye.replaceChildren(icon(state === "none" ? ICONS.eyeOff : ICONS.eye, 18));
    this.buildDayPanel();
  }

  // ---- selection & edits -------------------------------------------------------------------------

  private select(id: number | null, how: { fly?: boolean; scroll?: boolean; byPlayer?: boolean } = {}): void {
    if (!how.byPlayer) this.player.pause();
    this.selectedId = id;
    const it = id == null ? null : (this.items[id] ?? null);
    const dayChanged = !!(it && this.dayKey && dayKeyOf(it) !== this.dayKey);
    if (it && dayChanged) this.dayKey = dayKeyOf(it);
    this.map?.setSelected(it);
    if (it && how.fly) this.map?.flyTo(it);
    if (it && how.scroll) this.timeline.scrollToItem(it.id);
    this.timeline.refresh();
    this.refreshCard();
    if (dayChanged) this.refreshAll(false);
  }

  private openModal(id: number): void {
    const ids: number[] = [];
    for (const g of this.groups) for (const x of g.ids) if (this.typeOk(this.items[x]!)) ids.push(x);
    this.modal.open(ids, id);
  }

  private moveItem(id: number, lat: number, lon: number): void {
    const it = this.items[id];
    if (!it) return;
    const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
    this.items[id] = { ...it, lat: +clamp(lat, -90, 90).toFixed(6), lon: +wrapped.toFixed(6) };
    this.recomputeSuspects();
    this.persist();
    this.refreshAll(false);
    this.map?.setSelected(this.items[id]!);
  }

  private resetItem(id: number): void {
    const p = this.pristine[id];
    if (!p) return;
    this.items[id] = { ...this.items[id]!, lat: p.lat, lon: p.lon };
    this.recomputeSuspects();
    this.persist();
    this.refreshAll(false);
    if (this.selectedId === id) this.map?.setSelected(this.items[id]!);
    if (this.selectedId === id) this.map?.flyTo(this.items[id]!);
  }

  private setHidden(ids: number[], hide: boolean): void {
    for (const id of ids) hide ? this.hidden.add(id) : this.hidden.delete(id);
    this.persist();
    this.refreshAll(false);
  }

  private selectDay(key: string | null, fit = true): void {
    this.dayKey = key;
    this.refreshAll(false);
    if (key) this.timeline.scrollToDay(key);
    if (fit) this.map?.fit(this.mapItems());
  }

  private stepDay(d: number): void {
    const days = this.visibleDays();
    if (!days.length) return;
    const i = this.dayKey ? days.findIndex((g) => g.key === this.dayKey) : -1;
    const next = i < 0 ? (d > 0 ? 0 : days.length - 1) : clamp(i + d, 0, days.length - 1);
    this.selectDay(days[next]!.key);
  }

  // ---- theme / basemap ---------------------------------------------------------------------------

  private applyTheme(persist: boolean): void {
    const resolved = resolveTheme(this.themePref, !!this.mq?.matches);
    this.root.dataset.theme = resolved;
    this.root.dataset.themePref = this.themePref;
    const colors = readMapColors(this.root);
    this.ramp = routeRamp(colors, this.basemap);
    this.map?.setColors(colors);
    this.timeline.refresh();
    this.refreshLegend();
    if (persist) savePrefs({ theme: this.themePref });
    this.refreshPanels();
  }

  private setBasemap(id: BasemapId, persist: boolean): void {
    if (id === "terrain" && this.offline) return;
    this.basemap = id;
    this.map?.setBasemap(id, this.exaggeration);
    this.ramp = routeRamp(readMapColors(this.root), id);
    this.timeline.refresh();
    this.refreshLegend();
    if (persist) {
      this.basemapPref = id;
      savePrefs({ basemap: id });
    }
    this.refreshPanels();
  }

  private showToast(text: string, ms = 6000): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("is-on");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.updateHintToast(), ms);
  }

  private updateHintToast(): void {
    if (this.offlineHint && this.basemap === "offline") {
      this.toastEl.textContent = T.map.offlineHint;
      this.toastEl.classList.add("is-on");
    } else this.toastEl.classList.remove("is-on");
  }

  // ---- construction ------------------------------------------------------------------------------

  private createMap(): void {
    const mapEl = this.root.querySelector<HTMLElement>(".pw-map")!;
    try {
      const probe = document.createElement("canvas");
      if (!probe.getContext("webgl2")) throw new Error("no webgl2");
      this.map = new MapView(
        mapEl,
        {
          thumbUrl: (it) => this.resolve(it.thumb),
          item: (id) => this.items[id],
          colors: () => readMapColors(this.root),
          onSelect: (id) => this.select(id, { scroll: true }),
          onOpen: (id) => this.openModal(id),
          onMoved: (id, lat, lon) => this.moveItem(id, lat, lon),
          onOnlineFailed: () => {
            if (this.basemapPref === "auto" || this.basemapPref === undefined) this.setBasemap("offline", false);
            this.showToast(T.map.onlineFailed);
          },
          onOfflineZoomHint: (show) => {
            this.offlineHint = show;
            this.updateHintToast();
          },
          stopNumber: (id) => this.order.number.get(id) ?? null,
          tripT: this.tripT,
          onHover: (id) => this.hover(id),
        },
        { basemap: this.basemap, globe: this.globe, exaggeration: this.exaggeration },
      );
    } catch (e) {
      console.warn("Photo Way: map unavailable", e);
      mapEl.append(h("div", { class: "pw-nomap" }, T.noWebgl));
      this.map = null;
    }
    this.map?.setLook(this.look);
  }

  private build(): void {
    const r = this.root;
    this.titleEl = h("h1", { class: "pw-title" }, T.appName);
    this.statsEl = h("div", { class: "pw-stats" });
    const mkIconBtn = (label: string, path: string, cls = "") => {
      const b = h("button", { class: `pw-iconbtn ${cls}`, type: "button", title: label, "aria-label": label, "aria-haspopup": "true", "aria-expanded": "false" });
      b.append(icon(path, 20));
      return b;
    };
    const bFilters = mkIconBtn(T.toolbar.filters, ICONS.filter);
    const bLayers = mkIconBtn(T.toolbar.layers, ICONS.layers);
    const bTheme = mkIconBtn(T.toolbar.theme, ICONS.palette);
    const bMenu = mkIconBtn(T.toolbar.menu, ICONS.more);
    const header = h(
      "header",
      { class: "pw-top" },
      h("div", { class: "pw-brand" }, this.titleEl, this.statsEl),
      h("div", { class: "pw-actions" }, bFilters, bLayers, bTheme, bMenu),
    );

    // map + overlays
    const bFit = h("button", { class: "pw-tool", type: "button", title: T.toolbar.fit, "aria-label": T.toolbar.fit });
    bFit.append(icon(ICONS.fit, 18));
    bFit.addEventListener("click", () => this.map?.fit(this.mapItems()));
    const bGlobe = h("button", { class: "pw-tool", type: "button", title: T.toolbar.globe, "aria-label": T.toolbar.globe, "aria-pressed": "false" });
    bGlobe.append(icon(ICONS.globe, 18));
    bGlobe.addEventListener("click", () => {
      this.globe = !this.globe;
      this.map?.setGlobe(this.globe);
      bGlobe.setAttribute("aria-pressed", String(this.globe));
      bGlobe.title = this.globe ? T.toolbar.flat : T.toolbar.globe;
      bGlobe.replaceChildren(icon(this.globe ? ICONS.flat : ICONS.globe, 18));
    });
    this.playBtn = h("button", { class: "pw-tool", type: "button", title: T.play.play, "aria-label": T.play.play, "aria-pressed": "false" });
    this.playBtn.append(icon(ICONS.play, 18));
    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.speedBtn = h("button", { class: "pw-tool pw-speed", type: "button", hidden: true }, "1x");
    this.speedBtn.addEventListener("click", () => {
      this.player.cycleSpeed();
      this.refreshPlay();
    });
    this.legendEl = h("div", { class: "pw-legend", role: "img", "aria-label": T.legend.label, title: T.legend.label, hidden: true });
    this.cardEl = h("div", { class: "pw-card", hidden: true });
    this.toastEl = h("div", { class: "pw-toast", role: "status" });
    const tools = h("div", { class: "pw-tools" }, bFit, bGlobe, this.playBtn, this.speedBtn);
    const main = h("main", { class: "pw-main" }, h("div", { class: "pw-map" }), tools, this.legendEl, this.cardEl, this.toastEl);

    // bottom: day navigation + timeline
    const bPrev = h("button", { class: "pw-daybtn", type: "button", title: T.days.prev, "aria-label": T.days.prev });
    bPrev.append(icon(ICONS.chevL, 18));
    bPrev.addEventListener("click", () => this.stepDay(-1));
    const bNext = h("button", { class: "pw-daybtn", type: "button", title: T.days.next, "aria-label": T.days.next });
    bNext.append(icon(ICONS.chevR, 18));
    bNext.addEventListener("click", () => this.stepDay(1));
    this.dayBtnLabel = h("span", { class: "pw-daylabel" }, T.days.all);
    const bDay = h("button", { class: "pw-daypick", type: "button", title: T.days.list, "aria-haspopup": "true", "aria-expanded": "false" }, this.dayBtnLabel);
    bDay.append(icon(ICONS.chevD, 16));
    this.dayEye = h("button", { class: "pw-daybtn", type: "button", title: T.days.toggle, "aria-label": T.days.toggle });
    this.dayEye.addEventListener("click", () => {
      if (this.dayKey) this.toggleDay(this.dayKey);
    });
    this.dayCountEl = h("span", { class: "pw-daycount" });
    this.dayPanel = h("div", { class: "pw-pop pw-daypop", hidden: true, role: "menu" });
    const daynav = h("div", { class: "pw-daynav" }, bPrev, bDay, bNext, this.dayEye, this.dayCountEl, this.dayPanel);
    const bottom = h("section", { class: "pw-bottom", "aria-label": T.timeline.label }, daynav);
    this.timeline = new Timeline(bottom, {
      item: (id) => this.items[id],
      thumbUrl: (it) => this.resolve(it.thumb),
      isHidden: (id) => this.hidden.has(id),
      isSuspect: (id) => this.suspects.has(id),
      isFixed: (id) => this.isEdited(id) || !!this.items[id]?.flags?.includes("corrected"),
      isSelected: (id) => id === this.selectedId,
      dayCount: (key) => this.groupIds(key).length,
      dayState: this.dayState,
      isDaySelected: (key) => key === this.dayKey,
      onItemClick: (id) => this.select(id, { fly: true }),
      onItemOpen: (id) => {
        this.select(id, { fly: true });
        this.openModal(id);
      },
      onToggleItem: (id, visible) => this.setHidden([id], !visible),
      onDayClick: (key) => this.selectDay(this.dayKey === key ? null : key),
      onToggleDay: (key) => this.toggleDay(key),
      itemColor: this.itemColor,
      dayColor: this.dayColor,
      stopNumber: (id) => (this.look.numbers ? (this.order.number.get(id) ?? null) : null),
      onHover: (id) => this.map?.setHover(id),
    });
    this.modal = new Modal(r, {
      item: (id) => this.items[id],
      resolve: this.resolve,
      onShowOnMap: (id) => this.select(id, { fly: true, scroll: true }),
      onNavigate: (id) => this.select(id, { scroll: true }),
    });

    r.append(header, main, bottom);
    this.panels = {
      filters: this.buildFiltersPanel(),
      layers: this.buildLayersPanel(),
      theme: this.buildThemePanel(),
      menu: this.buildMenuPanel(),
    };
    r.append(this.panels.filters, this.panels.layers, this.panels.theme, this.panels.menu);
    this.pops = [
      { btn: bFilters, panel: this.panels.filters },
      { btn: bLayers, panel: this.panels.layers },
      { btn: bTheme, panel: this.panels.theme },
      { btn: bMenu, panel: this.panels.menu },
      { btn: bDay, panel: this.dayPanel },
    ];
    for (const p of this.pops) {
      p.btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.togglePop(p.panel);
      });
    }
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!this.pops.some((p) => !p.panel.hidden && (p.panel.contains(t) || p.btn.contains(t)))) this.closePops();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !this.modal.isOpen) this.closePops();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    const onConn = () => {
      this.offline = !navigator.onLine;
      this.refreshPanels();
    };
    window.addEventListener("online", onConn);
    window.addEventListener("offline", onConn);
    const onScheme = () => {
      if (this.themePref === "auto") this.applyTheme(false);
    };
    this.mq?.addEventListener?.("change", onScheme);
    this.cleanups.push(
      () => document.removeEventListener("pointerdown", onDown),
      () => document.removeEventListener("keydown", onKey),
      () => window.removeEventListener("online", onConn),
      () => window.removeEventListener("offline", onConn),
      () => this.mq?.removeEventListener?.("change", onScheme),
    );
  }

  private togglePop(panel: HTMLElement): void {
    const open = panel.hidden;
    this.closePops();
    if (open) {
      panel.hidden = false;
      const p = this.pops.find((x) => x.panel === panel);
      p?.btn.setAttribute("aria-expanded", "true");
      p?.btn.classList.add("is-open");
      if (panel === this.dayPanel) this.dayPanel.querySelector<HTMLElement>(".is-current")?.scrollIntoView({ block: "center" });
    }
  }

  private closePops(): void {
    for (const p of this.pops) {
      p.panel.hidden = true;
      p.btn.setAttribute("aria-expanded", "false");
      p.btn.classList.remove("is-open");
    }
  }

  private toggleDay(key: string): void {
    const ids = this.groupIds(key);
    this.setHidden(ids, this.dayState(key) !== "none");
  }

  // ---- panels ------------------------------------------------------------------------------------

  private buildFiltersPanel(): HTMLElement {
    const seg = h("div", { class: "pw-seg", role: "radiogroup", "aria-label": T.filters.type });
    for (const [v, label] of [
      ["all", T.filters.all],
      ["photo", T.filters.photo],
      ["video", T.filters.video],
      ["live", T.filters.live],
    ] as const) {
      const b = h("button", { type: "button", role: "radio", "data-v": v, class: "pw-seg-btn" }, label);
      b.addEventListener("click", () => {
        this.typeFilter = v;
        this.refreshAll(true);
      });
      seg.append(b);
    }
    const sw = (id: string, label: string, hint: string, get: () => boolean, set: (v: boolean) => void) => {
      const input = h("input", { type: "checkbox", id: `pw-sw-${id}`, class: "pw-switch-input" });
      input.addEventListener("change", () => set(input.checked));
      return h(
        "label",
        { class: "pw-switchrow", for: `pw-sw-${id}`, "data-get": id },
        h("span", { class: "pw-switchtext" }, h("span", { class: "pw-switchlabel" }, label), hint ? h("span", { class: "pw-hint" }, hint) : null),
        input,
        h("span", { class: "pw-switch", "aria-hidden": "true" }),
      );
    };
    const route = sw("route", T.filters.route, "", () => this.showRoute, (v) => {
      this.showRoute = v;
      this.refreshMap();
    });
    const lookSw = (key: keyof RouteLook, label: string, hint: string) =>
      sw(`look-${key}`, label, hint, () => this.look[key], (v) => this.setLook({ ...this.look, [key]: v }));
    const order = [
      h("div", { class: "pw-pop-title pw-pop-sub" }, T.filters.order),
      lookSw("timeColor", T.filters.timeColor, T.filters.timeColorHint),
      lookSw("numbers", T.filters.numbers, T.filters.numbersHint),
      lookSw("highlight", T.filters.highlight, T.filters.highlightHint),
    ];
    const speed = this.project?.options?.outlierSpeedKmh ?? DEFAULT_OUTLIER_KMH;
    const outl = sw("outliers", T.filters.outliers, T.filters.outliersHint.replace("{speed}", String(speed)), () => this.hideOutliers, (v) => {
      this.hideOutliers = v;
      this.refreshAll(false);
    });
    return h("div", { class: "pw-pop pw-pop-right", hidden: true, role: "dialog", "aria-label": T.filters.title }, h("div", { class: "pw-pop-title" }, T.filters.title), seg, route, outl, ...order);
  }

  private buildLayersPanel(): HTMLElement {
    const list = h("div", { class: "pw-maplist", role: "radiogroup", "aria-label": T.map.title });
    const slider = h("input", { type: "range", min: "1", max: "3", step: "0.1", value: String(this.exaggeration), class: "pw-range", "aria-label": T.map.exaggeration });
    slider.addEventListener("input", () => {
      this.exaggeration = Number(slider.value);
      this.map?.setExaggeration(this.exaggeration);
      readout.textContent = `${this.exaggeration.toFixed(1)}x`;
    });
    slider.addEventListener("change", () => savePrefs({ terrainExaggeration: this.exaggeration }));
    const readout = h("span", { class: "pw-readout" }, `${this.exaggeration.toFixed(1)}x`);
    const exag = h("div", { class: "pw-exag", hidden: true }, h("span", {}, T.map.exaggeration), slider, readout);
    for (const b of BASEMAPS) {
      const btn = h(
        "button",
        { type: "button", role: "radio", class: "pw-mapopt", "data-id": b.id },
        h("span", { class: "pw-mapswatch", style: `background:${b.swatch}` }),
        h("span", { class: "pw-maptext" }, h("span", { class: "pw-switchlabel" }, b.id === "satellite-labels" ? T.map.satelliteLabels : T.map[b.id]), h("span", { class: "pw-hint" }, b.online ? T.map.onlineNote : T.map.offlineNote)),
      );
      btn.addEventListener("click", () => this.setBasemap(b.id, true));
      list.append(btn);
    }
    return h("div", { class: "pw-pop pw-pop-right", hidden: true, role: "dialog", "aria-label": T.map.title }, h("div", { class: "pw-pop-title" }, T.map.title), list, exag);
  }

  private buildThemePanel(): HTMLElement {
    const list = h("div", { class: "pw-themelist", role: "radiogroup", "aria-label": T.theme.title });
    for (const id of THEME_IDS) {
      const sw = id === "auto" ? null : THEME_SWATCH[id];
      const chip = h(
        "span",
        { class: "pw-themechip" },
        ...(sw ? sw.map((c) => h("i", { style: `background:${c}` })) : [h("i", { style: "background:linear-gradient(90deg,#f7f5f0 50%,#14181e 50%);width:42px" })]),
      );
      const btn = h("button", { type: "button", role: "radio", class: "pw-themeopt", "data-id": id }, chip, h("span", { class: "pw-switchlabel" }, T.theme[id]));
      btn.addEventListener("click", () => {
        this.themePref = id;
        this.applyTheme(true);
      });
      list.append(btn);
    }
    return h("div", { class: "pw-pop pw-pop-right", hidden: true, role: "dialog", "aria-label": T.theme.title }, h("div", { class: "pw-pop-title" }, T.theme.title), list);
  }

  private menuInfo!: HTMLElement;
  private menuCopy!: HTMLElement;
  private menuCopyBtn!: HTMLButtonElement;
  private menuKeepHidden!: HTMLInputElement;

  private buildMenuPanel(): HTMLElement {
    const mkItem = (label: string, hint: string, path: string, fn: () => void) => {
      const b = h("button", { type: "button", class: "pw-menuitem" }, icon(path, 18), h("span", { class: "pw-maptext" }, h("span", { class: "pw-switchlabel" }, label), h("span", { class: "pw-hint" }, hint)));
      b.addEventListener("click", fn);
      return b;
    };
    this.menuInfo = h("div", { class: "pw-menuinfo" });
    const exportBtn = mkItem(T.menu.exportCorrections, T.menu.exportCorrectionsHint, ICONS.download, () => this.exportCorrections());
    this.menuKeepHidden = h("input", { type: "checkbox", id: "pw-keep-hidden" });
    this.menuCopyBtn = h("button", { type: "button", class: "pw-primary" }, icon(ICONS.download, 16), T.menu.saveCopyGo);
    // The download must start synchronously inside this click handler (Safari, Chrome multi-download guard).
    this.menuCopyBtn.addEventListener("click", () => this.saveCopy());
    this.menuCopy = h("div", { class: "pw-copybox", hidden: true }, h("label", { class: "pw-check", for: "pw-keep-hidden" }, this.menuKeepHidden, T.menu.saveCopyKeepHidden), this.menuCopyBtn);
    const copyItem = mkItem(T.menu.saveCopy, T.menu.saveCopyHint, ICONS.copy, () => {
      this.menuCopy.hidden = !this.menuCopy.hidden;
    });
    copyItem.classList.add("pw-copyitem");
    const reset = mkItem(T.menu.resetAll, "", ICONS.undo, () => {
      if (!confirm(T.menu.resetConfirm)) return;
      this.items = this.pristine.map((i) => ({ ...i }));
      this.hidden = new Set(this.pristine.filter((i) => i.flags?.includes("hidden")).map((i) => i.id));
      this.recomputeSuspects();
      this.persist();
      this.refreshAll(false);
      this.select(this.selectedId);
    });
    reset.classList.add("pw-resetitem");
    const languages = h("div", { class: "pw-language", role: "radiogroup", "aria-label": T.menu.language },
      h("div", { class: "pw-pop-title" }, T.menu.language));
    for (const [locale, label] of [["en", "English"], ["zh-CN", "简体中文"]] as const) {
      const button = h("button", { type: "button", role: "radio", class: "pw-language-opt", "aria-checked": String(this.locale === locale), lang: locale }, label);
      button.addEventListener("click", () => this.setLanguage(locale));
      languages.append(button);
    }
    const panel = h(
      "div",
      { class: "pw-pop pw-pop-right pw-menu", hidden: true, role: "menu", "aria-label": T.toolbar.menu },
      this.menuInfo,
      languages,
      exportBtn,
      this.opts.mode === "preview" ? null : copyItem,
      this.opts.mode === "preview" ? null : this.menuCopy,
      reset,
      h("div", { class: "pw-hint pw-privacy" }, T.menu.privacy),
    );
    return panel;
  }

  private updateMenu(): void {
    if (!this.menuInfo) return;
    const edits = this.currentEdits();
    const text = T.menu.edits(Object.keys(edits.fixes).length, edits.hidden.length);
    this.menuInfo.replaceChildren(text, ...(this.storageOk ? [] : [h("div", { class: "pw-warn" }, T.menu.storageOff)]));
    const inline = hasInlineData(document);
    const copyItem = this.panels?.menu.querySelector<HTMLButtonElement>(".pw-copyitem");
    if (copyItem) {
      copyItem.disabled = !inline;
      copyItem.title = inline ? "" : T.menu.saveCopyBundle;
      const hint = copyItem.querySelector(".pw-hint");
      if (hint) hint.textContent = inline ? T.menu.saveCopyHint : T.menu.saveCopyBundle;
    }
    const reset = this.panels?.menu.querySelector<HTMLButtonElement>(".pw-resetitem");
    if (reset) reset.disabled = !edits.hidden.length && !Object.keys(edits.fixes).length;
  }

  private exportCorrections(): void {
    const file = buildCorrections(this.project, this.currentEdits());
    downloadText(safeFilename(this.project.title, "corrections.json"), JSON.stringify(file, null, 2), "application/json");
  }

  private saveCopy(): void {
    const baked = bakeProject(this.project, this.currentEdits(), { keepHidden: this.menuKeepHidden.checked });
    baked.options = { ...baked.options, lang: this.locale };
    const html = renderCopyHtml(document, baked);
    if (html == null) return;
    downloadText(safeFilename(baked.title, "html"), html, "text/html");
  }

  private refreshPanels(): void {
    if (!this.panels) return;
    const f = this.panels.filters;
    f.querySelectorAll<HTMLElement>(".pw-seg-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === this.typeFilter)));
    const setSwitch = (id: string, v: boolean) => {
      const el = f.querySelector<HTMLInputElement>(`#pw-sw-${id}`);
      if (el) el.checked = v;
    };
    setSwitch("route", this.showRoute);
    setSwitch("outliers", this.hideOutliers);
    for (const k of ["timeColor", "numbers", "highlight"] as const) setSwitch(`look-${k}`, this.look[k]);
    const speed = this.project?.options?.outlierSpeedKmh ?? DEFAULT_OUTLIER_KMH;
    const oh = f.querySelector('[for="pw-sw-outliers"] .pw-hint');
    if (oh) oh.textContent = T.filters.outliersHint.replace("{speed}", String(speed));
    this.panels.layers.querySelectorAll<HTMLButtonElement>(".pw-mapopt").forEach((b) => {
      const id = b.dataset.id as BasemapId;
      b.setAttribute("aria-checked", String(id === this.basemap));
      const blocked = id === "terrain" && this.offline;
      b.disabled = blocked;
      b.title = blocked ? T.map.terrainOffline : "";
      const hint = b.querySelector(".pw-hint");
      if (hint && id === "terrain") hint.textContent = blocked ? T.map.terrainOffline : T.map.onlineNote;
    });
    const exag = this.panels.layers.querySelector<HTMLElement>(".pw-exag");
    if (exag) exag.hidden = this.basemap !== "terrain";
    this.panels.theme.querySelectorAll<HTMLElement>(".pw-themeopt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === this.themePref)));
  }

  private buildDayPanel(): void {
    const rows: HTMLElement[] = [];
    const all = h("button", { type: "button", class: `pw-dayrow${this.dayKey == null ? " is-current" : ""}`, role: "menuitem" }, h("span", { class: "pw-daydot", "data-state": "all" }), h("span", { class: "pw-daytext" }, T.days.all));
    all.addEventListener("click", () => {
      this.closePops();
      this.selectDay(null);
    });
    rows.push(all);
    for (const g of this.visibleDays()) {
      const p = parseDay(g.key);
      const label = p ? formatViewerDay(g.key, this.locale) : T.days.none;
      const eye = h("span", { class: "pw-dayeye", role: "button", tabindex: "0", title: T.days.toggle, "aria-label": T.days.toggle });
      eye.append(icon(this.dayState(g.key) === "none" ? ICONS.eyeOff : ICONS.eye, 16));
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleDay(g.key);
      });
      const row = h(
        "button",
        { type: "button", class: `pw-dayrow${g.key === this.dayKey ? " is-current" : ""}`, role: "menuitem" },
        h("span", { class: "pw-daydot", "data-state": this.dayState(g.key) }),
        h("span", { class: "pw-daytext" }, label, h("span", { class: "pw-hint" }, T.days.count(this.groupIds(g.key).length)), h("span", { class: "pw-hint pw-daystat" }, formatStat(this.tripStats.days.get(g.key), true, this.locale))),
        eye,
      );
      row.addEventListener("click", () => {
        this.closePops();
        this.selectDay(g.key);
      });
      rows.push(row);
    }
    this.dayPanel.replaceChildren(...rows);
  }

  // ---- selection card ----------------------------------------------------------------------------

  private refreshCard(): void {
    const id = this.selectedId;
    const it = id == null ? null : this.items[id];
    if (!it || this.player.active) {
      this.cardEl.hidden = true;
      return;
    }
    this.cardEl.hidden = false;
    const img = h("img", { alt: "", class: "pw-card-img", draggable: false });
    img.src = this.resolve(it.thumb);
    img.addEventListener("click", () => this.openModal(it.id));
    const tags: HTMLElement[] = [];
    if (this.isEdited(it.id)) tags.push(h("span", { class: "pw-tag pw-tag-fixed" }, T.card.corrected));
    if (this.suspects.has(it.id)) tags.push(h("span", { class: "pw-tag pw-tag-suspect" }, T.card.suspect));
    if (this.hidden.has(it.id)) tags.push(h("span", { class: "pw-tag" }, T.card.hiddenTag));
    const p = parseDay(it.day ?? (it.time ? it.time.slice(0, 10) : null));
    const when = p ? `${formatViewerDay(dayKeyOf(it), this.locale, "short")} · ${clockOf(it.time)}` : T.card.noTime;
    const btn = (label: string, path: string, fn: () => void, cls = "") => {
      const b = h("button", { type: "button", class: `pw-cardbtn ${cls}` }, icon(path, 15), label);
      b.addEventListener("click", fn);
      return b;
    };
    const close = h("button", { type: "button", class: "pw-cardclose", title: T.card.close, "aria-label": T.card.close });
    close.append(icon(ICONS.close, 16));
    close.addEventListener("click", () => this.select(null));
    this.cardEl.replaceChildren(
      img,
      h(
        "div",
        { class: "pw-cardbody" },
        h("div", { class: "pw-cardname" }, it.name, ...tags),
        h("div", { class: "pw-cardmeta" }, when, " · ", formatCoord(it.lat, it.lon)),
        h("div", { class: "pw-hint" }, T.card.dragHint),
        h(
          "div",
          { class: "pw-cardactions" },
          btn(T.card.open, ICONS.maximize, () => this.openModal(it.id), "is-primary"),
          this.isEdited(it.id) ? btn(T.card.reset, ICONS.undo, () => this.resetItem(it.id)) : null,
          this.hidden.has(it.id) ? btn(T.card.show, ICONS.eye, () => this.setHidden([it.id], false)) : btn(T.card.hide, ICONS.eyeOff, () => this.setHidden([it.id], true)),
        ),
      ),
      close,
    );
  }

  // ---- lifecycle / diagnostics ---------------------------------------------------------------------

  get mapView(): MapView | null {
    return this.map;
  }

  stats() {
    return {
      items: this.items.length,
      onMap: this.mapItems().length,
      suspects: this.suspects.size,
      tripStats: { total: this.tripStats.total, days: [...this.tripStats.days.values()] },
      hidden: this.hidden.size,
      edited: this.items.filter((i) => this.isEdited(i.id)).length,
      timelineNodes: this.timeline.renderedCount,
      selected: this.selectedId,
      theme: this.root.dataset.theme ?? "",
      basemap: this.basemap,
      modalOpen: this.modal.isOpen,
      play: this.player.state,
      legend: !this.legendEl.hidden,
      numberedCards: this.root.querySelectorAll(".pw-tl-num:not([hidden])").length,
      map: this.map?.stats() ?? null,
    };
  }

  destroy(): void {
    clearTimeout(this.toastTimer);
    this.player.destroy();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.modal.destroy();
    this.timeline.destroy();
    this.map?.destroy();
    this.resolver.dispose();
    this.root.remove();
    this.host.classList.remove("pw-host");
  }
}
