import type { Item, Project } from "./model";
import type { Edits } from "./persist";
import { uuid4 } from "./util";

const BACKSLASH = String.fromCharCode(92);
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/**
 * Escapes JSON for embedding in `<script type="application/json">` (DATA_CONTRACT 2.1):
 * every `<` becomes backslash-u003c, U+2028 / U+2029 become their backslash-u escapes.
 * The result is still valid JSON with identical meaning.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .split("<")
    .join(`${BACKSLASH}u003c`)
    .split(LINE_SEP)
    .join(`${BACKSLASH}u2028`)
    .split(PARA_SEP)
    .join(`${BACKSLASH}u2029`);
}

export interface BakeOptions {
  /** Keep hidden items in the copy, marked with the `hidden` flag. Default: drop them. */
  keepHidden?: boolean;
  newId?: string;
  now?: string;
}

const addFlag = (flags: string[] | undefined, flag: string): string[] => (flags?.includes(flag) ? [...flags] : [...(flags ?? []), flag]);

/** Applies edits to the project: positions replaced, flags set, ids renumbered, new id/createdAt. */
export function bakeProject(project: Project, edits: Edits, opts: BakeOptions = {}): Project {
  const hidden = new Set(edits.hidden);
  const kept: Item[] = [];
  for (const it of project.items) {
    const isHidden = hidden.has(it.id);
    if (isHidden && !opts.keepHidden) continue;
    let next: Item = { ...it };
    const fix = edits.fixes[it.id];
    if (fix) next = { ...next, lat: fix.lat, lon: fix.lon, flags: addFlag(next.flags, "corrected") };
    if (isHidden) next = { ...next, flags: addFlag(next.flags, "hidden") };
    else if (next.flags?.includes("hidden")) next = { ...next, flags: next.flags.filter((f) => f !== "hidden") };
    kept.push(next);
  }
  kept.forEach((it, i) => (it.id = i));
  return {
    ...project,
    id: opts.newId ?? uuid4(),
    createdAt: opts.now ?? new Date().toISOString(),
    items: kept,
  };
}

/**
 * Serialises the live document with `project` as its data (S2 gotcha 8): starts from a clone,
 * empties the mount point, drops runtime-only attributes, rewrites `#pw-data`, re-adds the doctype.
 * Returns null when the document has no `#pw-data` (bundle layout cannot rewrite itself).
 */
export function renderCopyHtml(doc: Document, project: Project): string | null {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  const data = root.querySelector("#pw-data");
  if (!data) return null;
  data.textContent = escapeJsonForScript(JSON.stringify(project));
  const mount = root.querySelector("#photoway");
  if (mount) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    for (const a of Array.from(mount.attributes)) if (a.name !== "id") mount.removeAttribute(a.name);
  }
  for (const el of [root, root.querySelector("body")]) {
    el?.removeAttribute("data-theme");
    el?.removeAttribute("data-pw-theme");
  }
  const titleEl = root.querySelector("title");
  if (titleEl) titleEl.textContent = project.title;
  return "<!doctype html>\n" + root.outerHTML;
}

export interface CorrectionsFile {
  format: "photoway-corrections";
  version: 1;
  projectId: string;
  fixes: { id: number; name: string; lat: number; lon: number }[];
  hidden: number[];
}

export function buildCorrections(project: Project, edits: Edits): CorrectionsFile {
  const fixes = Object.entries(edits.fixes)
    .map(([k, f]) => ({ id: Number(k), name: project.items[Number(k)]?.name ?? "", lat: f.lat, lon: f.lon }))
    .sort((a, b) => a.id - b.id);
  return { format: "photoway-corrections", version: 1, projectId: project.id, fixes, hidden: [...edits.hidden].sort((a, b) => a - b) };
}

/** Starts a download. Must be called synchronously from a user gesture (Safari, Chrome). */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function safeFilename(title: string, ext: string): string {
  const base = title.replace(/[^\p{L}\p{N}._ -]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "photoway";
  return `${base}.${ext}`;
}
