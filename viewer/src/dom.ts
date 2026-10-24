type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

/** Tiny hyperscript helper: `h("button", { class: "x", onclick: fn }, "Label")`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Inline stroke icon from a path string (24x24 grid). */
export function icon(paths: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths.split("|")) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  filter: "M4 5h16|M7 12h10|M10 19h4",
  layers: "M12 3 3 8l9 5 9-5-9-5z|M3 13l9 5 9-5",
  palette: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.6-2-.5-1.3.3-2.5 1.7-2.5H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5z",
  more: "M5 12h.01|M12 12h.01|M19 12h.01",
  fit: "M4 9V4h5|M20 9V4h-5|M4 15v5h5|M20 15v5h-5",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M3 12h18|M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z",
  flat: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z|M9 4v14|M15 6v14",
  chevL: "M15 5l-7 7 7 7",
  chevR: "M9 5l7 7-7 7",
  chevD: "M6 9l6 6 6-6",
  close: "M6 6l12 12|M18 6 6 18",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeOff: "M3 3l18 18|M10.6 6.1A9.7 9.7 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9|M6.5 7.6C3.6 9.4 2 12 2 12s3.6 6 10 6c1.4 0 2.7-.3 3.8-.8|M9.9 10a3 3 0 0 0 4.1 4.1",
  play: "M8 5v14l11-7L8 5z",
  pause: "M9 5v14|M15 5v14",
  download: "M12 4v11|M7 11l5 5 5-5|M5 20h14",
  copy: "M9 9h10v11H9z|M5 15V4h10",
  pin: "M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z|M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  undo: "M9 14 4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3",
  warn: "M12 4 2.5 20h19L12 4z|M12 10v4|M12 17h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  maximize: "M14 4h6v6|M10 20H4v-6|M20 4l-7 7|M4 20l7-7",
} as const;
