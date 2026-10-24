// App shell: add media, scan, build the preview, export. All heavy work happens in Rust.
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  api,
  errorText,
  onFinished,
  onMenu,
  onProgress,
  type Built,
  type Exported,
  type FormatId,
  type Phase,
  type Settings,
  type Summary,
} from "./api";
import { capturePosters, setProtocolBase } from "./poster";
import { S } from "./strings";

const BIG_HTML_BYTES = 50 * 1024 * 1024;
const MEDIA_EXTS = ["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "dng", "mov", "mp4", "m4v"];
const PRECISION: [number | null, string][] = [
  [null, ""],
  [6, "0.1 m"],
  [5, "1 m"],
  [4, "10 m"],
  [3, "100 m"],
  [2, "1 km"],
];
const WEB_EDGES = [1280, 1600, 2048, 2560, 3200, 4096];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Model {
  settings: Settings;
  summary: Summary | null;
  built: Built | null;
  /** Media options the current preview was built with. */
  builtKey: string;
  busy: Phase | "poster" | null;
  cancelPosters: boolean;
  exported: { path: string; format: FormatId } | null;
  serveUrl: string | null;
  previewUrl: string;
  previewShown: boolean;
}

const m: Model = {
  settings: {
    title: "",
    full: "web",
    webEdge: 2048,
    includeVideo: true,
    stripExif: true,
    coordDecimals: null,
    basemap: "auto",
    theme: "auto",
    format: "html",
  },
  summary: null,
  built: null,
  builtKey: "",
  busy: null,
  cancelPosters: false,
  exported: null,
  serveUrl: null,
  previewUrl: "",
  previewShown: false,
};

// ---- helpers ---------------------------------------------------------------------------

const mediaKey = (s: Settings) => `${s.full}|${s.webEdge}|${s.includeVideo}`;

function show(el: HTMLElement, visible: boolean) {
  el.hidden = !visible;
}

function message(text: string | null) {
  const el = $("message");
  el.textContent = text ?? "";
  show(el, !!text);
}

function fillSelect(el: HTMLSelectElement, options: [string, string][]) {
  el.replaceChildren(
    ...options.map(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      return o;
    }),
  );
}

function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "photo-way";
}

function joinPath(dir: string, name: string): string {
  const back = String.fromCharCode(92);
  const sep = dir.includes(back) ? back : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

let saveTimer: number | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void api.saveSettings(m.settings).catch(() => {}), 300);
}

// ---- rendering -------------------------------------------------------------------------

function renderSettings() {
  const s = m.settings;
  ($("opt-title") as HTMLInputElement).value = s.title;
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=full]")) r.checked = r.value === s.full;
  ($("opt-edge") as HTMLSelectElement).value = String(s.webEdge);
  ($("opt-video") as HTMLInputElement).checked = s.includeVideo;
  ($("opt-exif") as HTMLInputElement).checked = s.stripExif;
  ($("opt-precision") as HTMLSelectElement).value = s.coordDecimals === null ? "full" : String(s.coordDecimals);
  ($("opt-basemap") as HTMLSelectElement).value = s.basemap;
  ($("opt-theme") as HTMLSelectElement).value = s.theme;
  show($("edge-field"), s.full === "web");
}

function renderSummary() {
  const sum = m.summary;
  show($("summary"), !!sum);
  show($("options"), !!sum && sum.withLocation > 0);
  show($("actions"), !!sum && sum.withLocation > 0);
  if (!sum) return;
  $("summary-main").textContent =
    sum.withLocation > 0 ? S.foundMain(sum.withLocation, sum.found) : S.nothingFound;
  const kinds = sum.withLocation > 0 ? S.kinds(sum.photos, sum.videos, sum.live) : "";
  let dates = "";
  if (sum.firstDay && sum.lastDay) {
    dates = sum.firstDay === sum.lastDay ? S.dateRangeSame(sum.firstDay) : S.dateRange(sum.firstDay, sum.lastDay);
  } else if (sum.withLocation > 0) {
    dates = S.noDates;
  }
  $("summary-dates").textContent = [kinds, dates].filter(Boolean).join(". ");

  const skipped = sum.skipped.reduce((n, g) => n + g.count, 0);
  show($("skips"), skipped > 0);
  $("skips-summary").textContent = S.skipped(skipped);
  const body = $("skips-body");
  body.replaceChildren(
    ...sum.skipped.map((g) => {
      const d = document.createElement("details");
      const head = document.createElement("summary");
      head.textContent = `${g.label} (${g.count})`;
      const list = document.createElement("ul");
      for (const f of g.files) {
        const li = document.createElement("li");
        li.textContent = f;
        list.appendChild(li);
      }
      if (g.count > g.files.length) {
        const li = document.createElement("li");
        li.textContent = `... and ${(g.count - g.files.length).toLocaleString()} more`;
        list.appendChild(li);
      }
      d.append(head, list);
      return d;
    }),
  );
}

function renderActions() {
  const idle = m.busy === null;
  const build = $("btn-build") as HTMLButtonElement;
  build.textContent = m.built ? S.rebuild : S.build;
  build.disabled = !idle;
  ($("btn-export") as HTMLButtonElement).disabled = !idle || !m.built;
  for (const id of ["btn-files", "btn-folder"]) ($(id) as HTMLButtonElement).disabled = !idle;
  const stale = !!m.built && mediaKey(m.settings) !== m.builtKey;
  const staleEl = $("stale");
  staleEl.textContent = S.stale;
  show(staleEl, stale);
  show($("result"), !!m.exported);
  if (m.exported) {
    $("result-path").textContent = m.exported.path;
    ($("btn-open") as HTMLButtonElement).disabled = m.exported.format === "zip";
    ($("btn-serve") as HTMLButtonElement).textContent = m.serveUrl ? S.serveStop : S.serve;
    const info = $("serve-info");
    info.textContent = m.serveUrl ? S.serving(m.serveUrl) : "";
    show(info, !!m.serveUrl);
  }
}

function renderPreview() {
  const frame = $("preview") as HTMLIFrameElement;
  const has = !!m.built && m.built.items > 0;
  show($("empty"), !has);
  show(frame, has);
  if (!has) {
    if (m.previewShown) frame.src = "about:blank";
    m.previewShown = false;
  }
}

function showProgress(label: string, done: number, total: number, detail = "") {
  show($("progress"), true);
  $("progress-label").textContent = label;
  const bar = $("progress-bar") as HTMLProgressElement;
  bar.max = Math.max(total, 1);
  bar.value = done;
  $("progress-detail").textContent = detail || (total > 0 ? `${done.toLocaleString()} / ${total.toLocaleString()}` : "");
}

function hideProgress() {
  show($("progress"), false);
}

function renderAll() {
  renderSettings();
  renderSummary();
  renderActions();
  renderPreview();
}

// ---- preview ---------------------------------------------------------------------------

function loadPreview(version: number) {
  const frame = $("preview") as HTMLIFrameElement;
  renderPreview();
  if (!m.previewShown) {
    frame.src = `${m.previewUrl}?v=${version}`;
    m.previewShown = true;
  } else {
    frame.contentWindow?.postMessage({ type: "pw-reload" }, "*");
  }
}

let refreshTimer: number | undefined;
function refreshSoon() {
  clearTimeout(refreshTimer);
  if (!m.built) return;
  refreshTimer = window.setTimeout(async () => {
    try {
      const built = await api.refreshProject(m.settings);
      m.built = { ...m.built, ...built };
      loadPreview(built.version);
      renderActions();
    } catch (e) {
      message(errorText(e));
    }
  }, 400);
}

// ---- operations ------------------------------------------------------------------------

async function startScan(paths: string[], append: boolean) {
  if (m.busy || paths.length === 0) return;
  message(null);
  m.busy = "scan";
  m.built = null;
  m.exported = null;
  renderAll();
  showProgress(S.scanning, 0, 0);
  try {
    await api.scan(paths, append);
  } catch (e) {
    m.busy = null;
    hideProgress();
    message(errorText(e));
    renderAll();
  }
}

async function build() {
  if (m.busy || !m.summary) return;
  message(null);
  m.exported = null;
  await api.saveSettings(m.settings).catch(() => {});
  m.cancelPosters = false;
  let placeholders = 0;
  if (m.settings.includeVideo && m.summary.pendingPosters.length > 0) {
    m.busy = "poster";
    renderActions();
    const run = await capturePosters(
      m.summary.pendingPosters,
      (done, total) => showProgress(S.capturing, done, total),
      () => m.cancelPosters,
    );
    if (run.cancelled) {
      m.busy = null;
      hideProgress();
      message(S.cancelled);
      renderActions();
      return;
    }
    placeholders = run.failed;
    // Videos that failed keep the placeholder; do not retry them on the next build in this session.
    m.summary.pendingPosters = [];
  }
  m.busy = "process";
  renderActions();
  showProgress(S.processing, 0, 0);
  try {
    await api.process(m.settings);
    pendingNotice = placeholders > 0 ? S.placeholders(placeholders) : "";
  } catch (e) {
    m.busy = null;
    hideProgress();
    message(errorText(e));
    renderActions();
  }
}

let pendingNotice = "";

function cancel() {
  m.cancelPosters = true;
  void api.cancel();
}

function onFinish(f: { phase: Phase; ok: boolean; cancelled: boolean; message?: string; data?: unknown }) {
  m.busy = null;
  hideProgress();
  if (f.cancelled) {
    message(S.cancelled);
  } else if (!f.ok) {
    message(f.message ?? "Something went wrong.");
  }
  if (f.phase === "scan" && f.ok) {
    m.summary = f.data as Summary;
  } else if (f.phase === "process" && f.ok) {
    const built = f.data as Built;
    m.built = built;
    m.builtKey = mediaKey(m.settings);
    const notes = [S.built(built.items)];
    if (built.errorCount) notes.push(S.failedItems(built.errorCount));
    if (pendingNotice) notes.push(pendingNotice);
    message(notes.join(" "));
    loadPreview(built.version);
  } else if (f.phase === "export" && f.ok) {
    const done = f.data as Exported;
    m.exported = { path: done.path, format: m.settings.format };
    m.serveUrl = null;
    void api.serveStop();
    message(S.exportedTo(done.bytes));
  }
  renderAll();
}

// ---- adding media ----------------------------------------------------------------------

async function addFiles() {
  const picked = await open({
    multiple: true,
    title: S.pickerTitleFiles,
    filters: [{ name: S.pickerPhotos, extensions: MEDIA_EXTS }],
  });
  if (picked) await startScan(Array.isArray(picked) ? picked : [picked], !!m.summary);
}

async function addFolder() {
  const picked = await open({ directory: true, multiple: true, title: S.pickerTitleFolder });
  if (picked) await startScan(Array.isArray(picked) ? picked : [picked], !!m.summary);
}

async function startOver() {
  if (m.busy) return;
  await api.serveStop().catch(() => {});
  await api.reset();
  m.summary = null;
  m.built = null;
  m.exported = null;
  m.serveUrl = null;
  message(null);
  renderAll();
}

// ---- export ----------------------------------------------------------------------------

function renderExportDialog() {
  const est = m.built?.estimates;
  const format = m.settings.format;
  for (const id of ["html", "dir", "zip"] as const) {
    $(`est-${id}`).textContent = est ? S.estimate(est[id]) : "";
    const radio = document.querySelector<HTMLInputElement>(`input[name=format][value=${id}]`);
    if (radio) radio.checked = id === format;
  }
  const warn = $("export-warn");
  const big = format === "html" && !!est && est.html > BIG_HTML_BYTES;
  warn.textContent = big && est ? S.bigHtml(est.html) : "";
  show(warn, big);
}

function openExport() {
  if (m.busy || !m.built) return;
  renderExportDialog();
  ($("export-dlg") as HTMLDialogElement).showModal();
}

async function runExport() {
  const format = m.settings.format;
  const name = slug(m.settings.title);
  let out: string | null = null;
  if (format === "html") {
    out = await save({ title: S.saveHtml, defaultPath: `${name}.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
  } else if (format === "zip") {
    out = await save({ title: S.saveZip, defaultPath: `${name}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
  } else {
    const parent = await open({ directory: true, title: S.saveDir });
    out = typeof parent === "string" ? joinPath(parent, name) : null;
  }
  if (!out) return;
  message(null);
  m.busy = "export";
  renderActions();
  showProgress(S.exporting, 0, 0);
  persist();
  try {
    await api.exportTo(format, out, m.settings);
  } catch (e) {
    m.busy = null;
    hideProgress();
    message(errorText(e));
    renderActions();
  }
}

async function toggleServe() {
  if (!m.exported) return;
  try {
    if (m.serveUrl) {
      await api.serveStop();
      m.serveUrl = null;
    } else {
      m.serveUrl = await api.serveStart(m.exported.path);
      await api.openInBrowser(m.serveUrl).catch(() => {});
    }
  } catch (e) {
    message(errorText(e));
  }
  renderActions();
}

// ---- wiring ----------------------------------------------------------------------------

function bindSettings() {
  const s = m.settings;
  const changed = (refresh: boolean) => {
    persist();
    renderSettings();
    renderActions();
    if (refresh) refreshSoon();
  };
  $("opt-title").addEventListener("input", (e) => {
    s.title = (e.target as HTMLInputElement).value;
    changed(true);
  });
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=full]")) {
    r.addEventListener("change", () => {
      s.full = r.value as Settings["full"];
      changed(false);
    });
  }
  $("opt-edge").addEventListener("change", (e) => {
    s.webEdge = Number((e.target as HTMLSelectElement).value);
    changed(false);
  });
  $("opt-video").addEventListener("change", (e) => {
    s.includeVideo = (e.target as HTMLInputElement).checked;
    changed(false);
  });
  $("opt-exif").addEventListener("change", (e) => {
    s.stripExif = (e.target as HTMLInputElement).checked;
    changed(true);
  });
  $("opt-precision").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    s.coordDecimals = v === "full" ? null : Number(v);
    changed(true);
  });
  $("opt-basemap").addEventListener("change", (e) => {
    s.basemap = (e.target as HTMLSelectElement).value;
    changed(true);
  });
  $("opt-theme").addEventListener("change", (e) => {
    s.theme = (e.target as HTMLSelectElement).value;
    changed(true);
  });
}

function bindExportDialog() {
  const dlg = $("export-dlg") as HTMLDialogElement;
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=format]")) {
    r.addEventListener("change", () => {
      m.settings.format = r.value as FormatId;
      persist();
      renderExportDialog();
    });
  }
  $("export-cancel").addEventListener("click", () => dlg.close());
  $("export-form").addEventListener("submit", (e) => {
    e.preventDefault();
    dlg.close();
    void runExport();
  });
}

async function init() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-s]")) {
    const v = (S as Record<string, unknown>)[el.dataset.s ?? ""];
    if (typeof v === "string") el.textContent = v;
  }
  fillSelect($("opt-edge") as HTMLSelectElement, WEB_EDGES.map((e) => [String(e), S.edgeOption(e)]));
  fillSelect(
    $("opt-precision") as HTMLSelectElement,
    PRECISION.map(([d, approx]) => [d === null ? "full" : String(d), d === null ? S.precisionFull : S.precisionDecimals(d, approx)]),
  );
  fillSelect($("opt-basemap") as HTMLSelectElement, S.basemaps.map(([v, l]) => [v, l]));
  fillSelect($("opt-theme") as HTMLSelectElement, S.themes.map(([v, l]) => [v, l]));

  const [info, settings] = await Promise.all([api.info(), api.getSettings()]);
  m.settings = settings;
  m.previewUrl = info.previewUrl;
  setProtocolBase(info.previewUrl);
  $("version").textContent = `v${info.version}`;

  bindSettings();
  bindExportDialog();
  $("btn-files").addEventListener("click", () => void addFiles());
  $("btn-folder").addEventListener("click", () => void addFolder());
  $("btn-reset").addEventListener("click", () => void startOver());
  $("btn-build").addEventListener("click", () => void build());
  $("btn-export").addEventListener("click", openExport);
  $("btn-cancel").addEventListener("click", cancel);
  $("btn-open").addEventListener("click", () => {
    if (m.exported) void api.openInBrowser(m.exported.path).catch((e) => message(errorText(e)));
  });
  $("btn-reveal").addEventListener("click", () => {
    if (m.exported) void api.reveal(m.exported.path).catch((e) => message(errorText(e)));
  });
  $("btn-serve").addEventListener("click", () => void toggleServe());

  await onProgress((p) => {
    const label = p.phase === "scan" ? S.scanning : p.phase === "process" ? S.processing : S.exporting;
    showProgress(label, p.done, p.total, p.label ? `${p.done.toLocaleString()} / ${p.total.toLocaleString()}  ${p.label}` : "");
  });
  await onFinished(onFinish);
  await onMenu((id) => {
    if (id === "add-files") void addFiles();
    else if (id === "add-folder") void addFolder();
    else if (id === "export") openExport();
  });
  await getCurrentWebview().onDragDropEvent((e) => {
    const t = e.payload.type;
    show($("drop-overlay"), t === "enter" || t === "over");
    if (t === "drop") void startScan(e.payload.paths, !!m.summary);
  });
  renderAll();
}

void init().catch((e) => message(errorText(e)));
