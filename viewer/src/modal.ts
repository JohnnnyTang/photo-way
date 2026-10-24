import { h, icon, ICONS } from "./dom";
import type { Item } from "./model";
import { T } from "./strings";
import { clockOf, formatCoord, formatDuration, parseDay } from "./util";

export interface ModalHost {
  item(id: number): Item | undefined;
  resolve(ref: string, mime?: string): string;
  onShowOnMap(id: number): void;
  onNavigate(id: number): void;
}

export class Modal {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private info: HTMLElement;
  private counter: HTMLElement;
  private ids: number[] = [];
  private index = -1;
  private prevFocus: Element | null = null;
  private swipe: { x: number; y: number; id: number } | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor(
    parent: HTMLElement,
    private host: ModalHost,
  ) {
    const mkBtn = (cls: string, label: string, path: string, fn: () => void) => {
      const b = h("button", { class: `pw-modal-btn ${cls}`, type: "button", title: label, "aria-label": label });
      b.append(icon(path, 22));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    this.stage = h("div", { class: "pw-modal-stage" });
    this.info = h("div", { class: "pw-modal-info" });
    this.counter = h("div", { class: "pw-modal-counter" });
    const close = mkBtn("pw-modal-close", T.modal.close, ICONS.close, () => this.close());
    const prev = mkBtn("pw-modal-prev", T.modal.prev, ICONS.chevL, () => this.step(-1));
    const next = mkBtn("pw-modal-next", T.modal.next, ICONS.chevR, () => this.step(1));
    this.el = h("div", { class: "pw-modal", role: "dialog", "aria-modal": "true", "aria-label": T.appName, hidden: true }, this.stage, this.info, this.counter, close, prev, next);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el || e.target === this.stage) this.close();
    });
    this.el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("video,button,a")) return;
      this.swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    this.el.addEventListener("pointerup", (e) => {
      const s = this.swipe;
      this.swipe = null;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.step(dx < 0 ? 1 : -1);
      else if (dy > 110 && Math.abs(dx) < 70) this.close();
    });
    this.el.addEventListener("pointercancel", () => (this.swipe = null));
    parent.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  get currentId(): number | null {
    return this.isOpen ? (this.ids[this.index] ?? null) : null;
  }

  open(ids: number[], id: number): void {
    const i = ids.indexOf(id);
    if (i < 0) return;
    this.ids = ids;
    this.index = i;
    if (!this.isOpen) {
      this.prevFocus = document.activeElement;
      this.el.hidden = false;
      document.addEventListener("keydown", this.keyHandler, true);
    }
    this.show();
    this.el.querySelector<HTMLElement>(".pw-modal-close")?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.stage.replaceChildren();
    document.removeEventListener("keydown", this.keyHandler, true);
    (this.prevFocus as HTMLElement | null)?.focus?.({ preventScroll: true });
    this.prevFocus = null;
  }

  step(d: number): void {
    if (this.ids.length < 2) return;
    this.index = (this.index + d + this.ids.length) % this.ids.length;
    this.show();
    const id = this.ids[this.index];
    if (id != null) this.host.onNavigate(id);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") this.close();
    else if (e.key === "ArrowLeft") this.step(-1);
    else if (e.key === "ArrowRight") this.step(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private show(): void {
    const id = this.ids[this.index];
    const it = id == null ? undefined : this.host.item(id);
    this.stage.replaceChildren();
    if (!it) return;
    const note = (text: string) => this.stage.append(h("div", { class: "pw-modal-note" }, text));
    const thumb = this.host.resolve(it.thumb);

    if (it.kind === "video" && it.video) {
      const v = h("video", { class: "pw-modal-media", controls: true, playsinline: true, preload: "metadata", poster: thumb });
      v.src = this.host.resolve(it.video, "video/mp4");
      this.stage.append(v);
    } else {
      const img = h("img", { class: "pw-modal-media is-loading", alt: it.name, draggable: false });
      img.src = thumb;
      this.stage.append(img);
      if (it.full) {
        const big = new Image();
        big.decoding = "async";
        big.onload = () => {
          if (img.isConnected) {
            img.src = big.src;
            img.classList.remove("is-loading");
          }
        };
        big.src = this.host.resolve(it.full);
      } else {
        img.classList.remove("is-loading");
        if (it.kind !== "video") note(T.modal.thumbOnly);
      }
      if (it.kind === "video") note(T.modal.videoMissing);
      if (it.kind === "live" && it.video) {
        const btn = h("button", { class: "pw-modal-live", type: "button" }, icon(ICONS.play, 16), T.modal.liveHold);
        btn.addEventListener("click", () => {
          const v = h("video", { class: "pw-modal-media", playsinline: true, autoplay: true, controls: false });
          v.src = this.host.resolve(it.video!, "video/mp4");
          v.addEventListener("ended", () => this.show());
          this.stage.replaceChildren(v);
        });
        this.stage.append(btn);
      }
    }
    this.preload(this.index + 1);
    this.preload(this.index - 1);

    const p = parseDay(it.day ?? (it.time ? it.time.slice(0, 10) : null));
    const when = p ? `${p.weekday}, ${p.monthName} ${p.day}, ${p.year} · ${clockOf(it.time)}` : T.card.noTime;
    const dur = formatDuration(it.dur);
    const show = h("button", { class: "pw-link", type: "button" }, icon(ICONS.pin, 14), T.modal.showOnMap);
    show.addEventListener("click", () => {
      this.close();
      this.host.onShowOnMap(it.id);
    });
    this.info.replaceChildren(
      h("div", { class: "pw-modal-name" }, it.name),
      h("div", { class: "pw-modal-meta" }, when + (dur ? ` · ${dur}` : ""), " · ", formatCoord(it.lat, it.lon)),
      show,
    );
    this.counter.textContent = T.modal.counter(this.index + 1, this.ids.length);
  }

  private preload(i: number): void {
    const id = this.ids[(i + this.ids.length) % this.ids.length];
    const it = id == null ? undefined : this.host.item(id);
    if (it && it.kind !== "video" && it.full) {
      const im = new Image();
      im.src = this.host.resolve(it.full);
    }
  }

  destroy(): void {
    document.removeEventListener("keydown", this.keyHandler, true);
    this.el.remove();
  }
}
