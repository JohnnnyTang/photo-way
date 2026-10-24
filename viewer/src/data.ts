import type { Project } from "./model";

declare global {
  interface Window {
    __PHOTOWAY__?: Project;
  }
}

/** Finds embedded project data: `#pw-data` (single HTML) or `window.__PHOTOWAY__` (bundle). */
export function findProject(doc: Document = document, win: Window = window): Project | null {
  try {
    const el = doc.getElementById("pw-data");
    if (el?.textContent && el.textContent.trim()) return JSON.parse(el.textContent) as Project;
  } catch (e) {
    console.error("Photo Way: cannot parse #pw-data", e);
  }
  return win.__PHOTOWAY__ ?? null;
}

/** True when the project was read from `#pw-data` (a single HTML file that can rewrite itself). */
export function hasInlineData(doc: Document = document): boolean {
  return !!doc.getElementById("pw-data");
}

export interface ParsedPackRef {
  pack: string;
  offset: number;
  length: number;
}

export function parsePackRef(ref: string): ParsedPackRef | null {
  if (!ref.startsWith("#pack:")) return null;
  const parts = ref.split(":");
  const offset = Number(parts[2]);
  const length = Number(parts[3]);
  if (!parts[1] || !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) return null;
  return { pack: parts[1], offset, length };
}

/**
 * Decodes bytes `[offset, offset+length)` of a base64 pack without decoding the whole pack:
 * only the base64 characters `floor(offset/3)*4 .. ceil((offset+length)/3)*4` are touched.
 */
export function decodePackSlice(b64: string, offset: number, length: number): Uint8Array<ArrayBuffer> {
  const c0 = Math.floor(offset / 3) * 4;
  const c1 = Math.ceil((offset + length) / 3) * 4;
  const bin = atob(b64.slice(c0, c1));
  const skip = offset - (c0 / 4) * 3;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = bin.charCodeAt(skip + i);
  return out;
}

export interface PackSource {
  /** Base64 text without whitespace. */
  text: string;
  mime: string;
}

export interface RefResolver {
  /** relative URL as is; pack refs become cached `blob:` URLs created on first use. */
  resolve(ref: string, mime?: string): string;
  /** Number of blob URLs created so far (diagnostics, tests). */
  readonly created: number;
  dispose(): void;
}

export function createResolver(
  getPack: (name: string) => PackSource | null,
  makeUrl: (blob: Blob) => string = (b) => URL.createObjectURL(b),
  revokeUrl: (url: string) => void = (u) => URL.revokeObjectURL(u),
): RefResolver {
  const urls = new Map<string, string>();
  const packs = new Map<string, PackSource | null>();
  return {
    resolve(ref, mime) {
      const p = parsePackRef(ref);
      if (!p) return ref;
      let url = urls.get(ref);
      if (url) return url;
      if (!packs.has(p.pack)) packs.set(p.pack, getPack(p.pack));
      const pack = packs.get(p.pack);
      if (!pack) return "";
      try {
        const bytes = decodePackSlice(pack.text, p.offset, p.length);
        url = makeUrl(new Blob([bytes], { type: mime ?? pack.mime }));
      } catch (e) {
        console.error("Photo Way: cannot decode", ref, e);
        return "";
      }
      urls.set(ref, url);
      return url;
    },
    get created() {
      return urls.size;
    },
    dispose() {
      for (const u of urls.values()) revokeUrl(u);
      urls.clear();
      packs.clear();
    },
  };
}

const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

/** Reads `<script id="pw-pack-NAME" data-mime="...">` from the document. */
export function domPackReader(doc: Document = document): (name: string) => PackSource | null {
  return (name) => {
    const el = doc.getElementById(`pw-pack-${name}`);
    if (!el) return null;
    let text = el.textContent ?? "";
    if (text.length && (isWs(text.charCodeAt(0)) || isWs(text.charCodeAt(text.length - 1)))) text = text.trim();
    return { text, mime: el.getAttribute("data-mime") || "image/jpeg" };
  };
}
