import type { Row } from "./days";
import { h, icon, ICONS } from "./dom";
import type { Item } from "./model";
import { T } from "./strings";
import { clockOf, formatDuration, formatViewerDay, parseDay } from "./util";
import type { Locale } from "../../shared/locale";

export type DayState = "all" | "some" | "none";

export interface TimelineHost {
  item(id: number): Item | undefined;
  thumbUrl(item: Item): string;
  isHidden(id: number): boolean;
  isSuspect(id: number): boolean;
  isFixed(id: number): boolean;
  isSelected(id: number): boolean;
  dayCount(key: string): number;
  dayState(key: string): DayState;
  isDaySelected(key: string): boolean;
  onItemClick(id: number): void;
  onItemOpen(id: number): void;
  onToggleItem(id: number, visible: boolean): void;
  onDayClick(key: string): void;
  onToggleDay(key: string): void;
  /** Trip-order colour of an item or a day (colour by time), `null` when off. */
  itemColor(id: number): string | null;
  dayColor(key: string): string | null;
  /** Stop number when numbering is on. */
  stopNumber(id: number): number | null;
  onHover(id: number | null): void;
}

/** Shows the trip-order colour as a stripe (`--pw-trip`), or removes it. */
function paintTrip(node: HTMLElement, color: string | null): void {
  if (color) node.style.setProperty("--pw-trip", color);
  else node.style.removeProperty("--pw-trip");
  node.classList.toggle("has-trip", !!color);
}

export const DAY_W = 84;
export const ITEM_W = 92;
const OVERSCAN = 8;

/** Horizontal, virtualized strip: only the rows near the viewport exist in the DOM. */
export class Timeline {
  readonly scroller: HTMLElement;
  private inner: HTMLElement;
  private rows: Row[] = [];
  private offsets: number[] = [];
  private total = 0;
  private nodes = new Map<string, HTMLElement>();
  private raf = 0;
  private ro: ResizeObserver | null = null;
  private empty: HTMLElement;
  private lastClick = { id: -1, t: 0 };
  private hoverId: number | null = null;

  constructor(
    parent: HTMLElement,
    private host: TimelineHost,
  ) {
    this.inner = h("div", { class: "pw-tl-inner" });
    this.empty = h("div", { class: "pw-tl-empty" }, T.timeline.empty);
    this.scroller = h("div", { class: "pw-tl-scroller", role: "list", "aria-label": T.timeline.label, tabindex: "-1" }, this.inner, this.empty);
    parent.append(this.scroller);
    this.scroller.addEventListener("scroll", () => this.schedule(), { passive: true });
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.total > this.scroller.clientWidth) {
          this.scroller.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.schedule());
      this.ro.observe(this.scroller);
    }
  }

  setRows(rows: Row[]): void {
    this.rows = rows;
    this.offsets = new Array<number>(rows.length);
    let x = 0;
    rows.forEach((r, i) => {
      this.offsets[i] = x;
      x += r.kind === "day" ? DAY_W : ITEM_W;
    });
    this.total = x;
    this.inner.style.width = `${x}px`;
    this.empty.style.display = rows.length ? "none" : "";
    for (const n of this.nodes.values()) n.remove();
    this.nodes.clear();
    this.render();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private firstVisible(x: number): number {
    let lo = 0;
    let hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.offsets[mid] ?? 0) <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private rowKey(r: Row): string {
    return r.kind === "day" ? `d:${r.key}` : `i:${r.id}`;
  }

  /** Number of row nodes currently in the DOM (tests and diagnostics). */
  get renderedCount(): number {
    return this.nodes.size;
  }

  private render(): void {
    const n = this.rows.length;
    if (!n) return;
    const left = this.scroller.scrollLeft;
    const width = this.scroller.clientWidth || 800;
    const start = Math.max(0, this.firstVisible(left) - OVERSCAN);
    let end = start;
    while (end < n && (this.offsets[end] ?? 0) < left + width) end++;
    end = Math.min(n, end + OVERSCAN);
    const keep = new Set<string>();
    for (let i = start; i < end; i++) {
      const row = this.rows[i]!;
      const key = this.rowKey(row);
      keep.add(key);
      let node = this.nodes.get(key);
      if (!node) {
        node = (row.kind === "day" ? this.makeDay(row.key) : this.makeItem(row.id)) ?? undefined;
        if (!node) continue;
        node.style.transform = `translateX(${this.offsets[i]}px)`;
        this.inner.append(node);
        this.nodes.set(key, node);
      }
      this.update(row, node);
    }
    for (const [key, node] of this.nodes) {
      if (!keep.has(key)) {
        node.remove();
        this.nodes.delete(key);
      }
    }
  }

  /** Re-applies selection / hidden / badge state to rendered rows. */
  refresh(): void {
    this.rows.forEach((row) => {
      const node = this.nodes.get(this.rowKey(row));
      if (node) this.update(row, node);
    });
  }

  refreshLanguage(): void {
    this.empty.textContent = T.timeline.empty;
    this.scroller.setAttribute("aria-label", T.timeline.label);
    this.setRows(this.rows);
  }

  private update(row: Row, node: HTMLElement): void {
    if (row.kind === "day") {
      const state = this.host.dayState(row.key);
      node.dataset.state = state;
      node.classList.toggle("is-current", this.host.isDaySelected(row.key));
      const count = node.querySelector(".pw-tl-daycount");
      if (count) count.textContent = T.days.count(this.host.dayCount(row.key));
      paintTrip(node, this.host.dayColor(row.key));
      return;
    }
    const id = row.id;
    const hidden = this.host.isHidden(id);
    node.classList.toggle("is-hidden", hidden);
    node.classList.toggle("is-selected", this.host.isSelected(id));
    const suspect = this.host.isSuspect(id);
    const fixed = this.host.isFixed(id);
    node.classList.toggle("is-suspect", suspect);
    node.classList.toggle("is-fixed", fixed);
    node.setAttribute("aria-current", this.host.isSelected(id) ? "true" : "false");
    const cb = node.querySelector<HTMLInputElement>("input.pw-tl-check");
    if (cb) cb.checked = !hidden;
    node.classList.toggle("is-hover", id === this.hoverId);
    paintTrip(node, this.host.itemColor(id));
    const num = node.querySelector<HTMLElement>(".pw-tl-num");
    const n = this.host.stopNumber(id);
    if (num) {
      num.hidden = n == null;
      num.textContent = n == null ? "" : `#${n}`;
    }
  }

  /** Marks the card of the item hovered on the map (or clears it). */
  setHover(id: number | null): void {
    const old = this.hoverId;
    this.hoverId = id;
    if (old != null) this.nodes.get(`i:${old}`)?.classList.remove("is-hover");
    if (id != null) this.nodes.get(`i:${id}`)?.classList.add("is-hover");
  }

  private makeDay(key: string): HTMLElement {
    const p = parseDay(key);
    const eye = h("button", { class: "pw-tl-eye", type: "button", title: T.days.toggle, "aria-label": T.days.toggle });
    eye.append(icon(ICONS.eye, 16));
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      this.host.onToggleDay(key);
    });
    const node = h(
      "div",
      { class: "pw-tl-day", role: "listitem", tabindex: "0", "data-key": key },
      h("div", { class: "pw-tl-daynum" }, p ? String(p.day) : "?"),
      h("div", { class: "pw-tl-daymon" }, p ? formatViewerDay(key, document.documentElement.lang as Locale, "month") : T.days.none),
      h("div", { class: "pw-tl-daywd" }, p ? p.weekday : ""),
      h("div", { class: "pw-tl-daycount" }, ""),
      eye,
      h("span", { class: "pw-tl-trip", "aria-hidden": "true" }),
    );
    node.addEventListener("click", () => this.host.onDayClick(key));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.host.onDayClick(key);
      }
    });
    return node;
  }

  private makeItem(id: number): HTMLElement | null {
    const it = this.host.item(id);
    if (!it) return null;
    const img = h("img", { alt: "", decoding: "async", loading: "lazy", draggable: false });
    img.src = this.host.thumbUrl(it);
    const cb = h("input", { class: "pw-tl-check", type: "checkbox", checked: true, title: T.timeline.hide, "aria-label": `${T.timeline.hide}: ${it.name}` });
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => this.host.onToggleItem(id, cb.checked));
    const badge =
      it.kind === "video"
        ? h("span", { class: "pw-tl-kind", title: T.timeline.video }, icon(ICONS.play, 11), formatDuration(it.dur))
        : it.kind === "live"
          ? h("span", { class: "pw-tl-kind pw-tl-live", title: T.timeline.live }, T.timeline.live)
          : null;
    const flags = h(
      "span",
      { class: "pw-tl-flags" },
      h("span", { class: "pw-tl-flag pw-flag-suspect", title: T.timeline.suspect }, icon(ICONS.warn, 12)),
      h("span", { class: "pw-tl-flag pw-flag-fixed", title: T.timeline.fixed }, icon(ICONS.pin, 12)),
    );
    const node = h(
      "div",
      { class: "pw-tl-item", role: "listitem", tabindex: "0", "data-id": id, title: `${it.name}\n${T.timeline.hint}` },
      img,
      cb,
      badge,
      flags,
      h("span", { class: "pw-tl-time" }, clockOf(it.time), h("span", { class: "pw-tl-num", hidden: true })),
      h("span", { class: "pw-tl-trip", "aria-hidden": "true" }),
    );
    node.addEventListener("mouseenter", () => this.host.onHover(id));
    node.addEventListener("mouseleave", () => this.host.onHover(null));
    node.addEventListener("click", () => {
      const now = Date.now();
      const dbl = this.lastClick.id === id && now - this.lastClick.t < 450;
      this.lastClick = { id, t: now };
      if (dbl) this.host.onItemOpen(id);
      else this.host.onItemClick(id);
    });
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.host.onItemOpen(id);
      } else if (e.key === " ") {
        e.preventDefault();
        this.host.onItemClick(id);
      }
    });
    return node;
  }

  private indexOf(pred: (r: Row) => boolean): number {
    return this.rows.findIndex(pred);
  }

  /** Scrolls so the row is centred (items) or at the left edge (days). */
  scrollToItem(id: number, smooth = true): void {
    const i = this.indexOf((r) => r.kind === "item" && r.id === id);
    if (i < 0) return;
    const x = (this.offsets[i] ?? 0) + ITEM_W / 2 - this.scroller.clientWidth / 2;
    this.scrollTo(x, smooth);
  }

  scrollToDay(key: string, smooth = true): void {
    const i = this.indexOf((r) => r.kind === "day" && r.key === key);
    if (i >= 0) this.scrollTo(this.offsets[i] ?? 0, smooth);
  }

  private scrollTo(x: number, smooth: boolean): void {
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.scroller.scrollTo({ left: Math.max(0, x), behavior: smooth && !reduce ? "smooth" : "auto" });
    this.schedule();
  }

  destroy(): void {
    this.ro?.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.scroller.remove();
  }
}
