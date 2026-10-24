import type { Project } from "./model";

declare global {
  interface Window {
    __PHOTOWAY__?: Project;
  }
}

/** Finds embedded project data: `#pw-data` (single HTML) or `window.__PHOTOWAY__` (bundle). */
export function findProject(doc: Document = document): Project | null {
  const el = doc.getElementById("pw-data");
  if (el?.textContent) return JSON.parse(el.textContent) as Project;
  return window.__PHOTOWAY__ ?? null;
}

const packCache = new Map<string, Uint8Array<ArrayBuffer>>();
const blobUrls = new Map<string, string>();

function pack(name: string, doc: Document): Uint8Array<ArrayBuffer> {
  let bytes = packCache.get(name);
  if (!bytes) {
    const b64 = doc.getElementById(`pw-pack-${name}`)?.textContent?.trim() ?? "";
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    packCache.set(name, bytes);
  }
  return bytes;
}

/** Turns a contract Ref into a URL usable by <img>/<video>. Pack refs become cached blob: URLs. */
export function resolveRef(ref: string, mime = "image/jpeg", doc: Document = document): string {
  if (!ref.startsWith("#pack:")) return ref;
  let url = blobUrls.get(ref);
  if (!url) {
    const [, , name = "", off = "0", len = "0"] = ref.split(":");
    const bytes = pack(name, doc).subarray(Number(off), Number(off) + Number(len));
    url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    blobUrls.set(ref, url);
  }
  return url;
}
