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
  type PhotosImportRequest,
  type PhotosImportResult,
  type Settings,
  type Summary,
} from "./api";
import { capturePosters, setProtocolBase } from "./poster";
import { appStrings } from "./catalog";
import { formatCount, formatDay, resolveAppLocale, resolveExportLocale, type Locale } from "../../../shared/locale";
import { message as localizedMessage, type MessageCode } from "../../../shared/messages";

let locale: Locale = resolveAppLocale("system", navigator.language);
let S = appStrings(locale);

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
    language: "system",
    exportLanguage: null,
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

function operationError(e: unknown): string {
  const raw = errorText(e);
  const code: MessageCode = raw === "Another operation is still running." ? "busy" : "other";
  return code === "busy" ? localizedMessage(locale, code) : `${localizedMessage(locale, code)} ${raw}`;
}

let notice: (() => string) | null = null;
function status(makeText: () => string) {
  notice = makeText;
  message(makeText());
}

function clearStatus() {
  notice = null;
  message(null);
}

function localize() {
  locale = resolveAppLocale(m.settings.language, navigator.language);
  S = appStrings(locale);
  document.documentElement.lang = locale;
  for (const el of document.querySelectorAll<HTMLElement>("[data-s]")) {
    const value = (S as Record<string, unknown>)[el.dataset.s ?? ""];
    if (typeof value === "string") el.textContent = value;
  }
  fillSelect($("opt-language") as HTMLSelectElement, [["system", S.languageSystem], ["en", S.languageEnglish], ["zh-CN", S.languageChinese]]);
  fillSelect($("opt-export-language") as HTMLSelectElement, [["en", S.languageEnglish], ["zh-CN", S.languageChinese]]);
  fillSelect($("opt-edge") as HTMLSelectElement, WEB_EDGES.map((edge) => [String(edge), S.edgeOption(edge)]));
  fillSelect($("opt-precision") as HTMLSelectElement,
    PRECISION.map(([d, approx]) => [d === null ? "full" : String(d), d === null ? S.precisionFull : S.precisionDecimals(d, approx)]));
  fillSelect($("opt-basemap") as HTMLSelectElement, S.basemaps.map(([value, label]) => [value, label]));
  fillSelect($("opt-theme") as HTMLSelectElement, S.themes.map(([value, label]) => [value, label]));
  ($("preview") as HTMLIFrameElement).title = S.previewTitle;
  renderAll();
  if (m.busy) renderProgress();
  if (($("export-dlg") as HTMLDialogElement).open) renderExportDialog();
  if (notice) message(notice());
  void api.setMenuLanguage(locale).catch(() => {});
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
let saveQueue: Promise<void> = Promise.resolve();
function saveNow(): Promise<void> {
  const snapshot = { ...m.settings };
  saveQueue = saveQueue.then(() => api.saveSettings(snapshot)).catch(() => {});
  return saveQueue;
}
function persist(immediate = false) {
  clearTimeout(saveTimer);
  if (immediate) {
    void saveNow();
    return;
  }
  saveTimer = window.setTimeout(() => void saveNow(), 300);
}

// ---- rendering -------------------------------------------------------------------------

function renderSettings() {
  const s = m.settings;
  ($("opt-language") as HTMLSelectElement).value = s.language;
  ($("opt-export-language") as HTMLSelectElement).value = resolveExportLocale(s.exportLanguage, locale);
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
    dates = sum.firstDay === sum.lastDay ? S.dateRangeSame(formatDay(sum.firstDay, locale)) : S.dateRange(formatDay(sum.firstDay, locale), formatDay(sum.lastDay, locale));
  } else if (sum.withLocation > 0) {
    dates = S.noDates;
  }
  $("summary-dates").textContent = [kinds, dates].filter(Boolean).join(S.summarySeparator);

  const skipped = sum.skipped.reduce((n, g) => n + g.count, 0);
  show($("skips"), skipped > 0);
  $("skips-summary").textContent = S.skipped(skipped);
  const body = $("skips-body");
  const expanded = new Set([...body.querySelectorAll<HTMLDetailsElement>("details[open]")].map((el) => el.dataset.reason));
  body.replaceChildren(
    ...sum.skipped.map((g) => {
      const d = document.createElement("details");
      d.dataset.reason = g.reason;
      d.open = expanded.has(g.reason);
      const head = document.createElement("summary");
      const reason = g.reason as MessageCode;
      const label = reason in { noLocation: 1, unreadable: 1, unsupported: 1, duplicate: 1 } ? localizedMessage(locale, reason) : g.label;
      head.textContent = `${label} (${formatCount(g.count, locale)})`;
      const list = document.createElement("ul");
      for (const f of g.files) {
        const li = document.createElement("li");
        li.textContent = f;
        list.appendChild(li);
      }
      if (g.count > g.files.length) {
        const li = document.createElement("li");
        li.textContent = S.skipMore(g.count - g.files.length);
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
  for (const id of ["btn-files", "btn-folder", "btn-photos-library"]) ($(id) as HTMLButtonElement).disabled = !idle;
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

let currentProgress: { phase: Phase | "poster"; done: number; total: number; file: string } | null = null;
function showProgress(phase: Phase | "poster", done: number, total: number, file = "") {
  currentProgress = { phase, done, total, file };
  renderProgress();
}

function renderProgress() {
  if (!currentProgress) return;
  const { phase, done, total, file } = currentProgress;
  show($("progress"), true);
  $("progress-label").textContent = phase === "import" ? S.photosImporting : phase === "scan" ? S.scanning : phase === "poster" ? S.capturing : phase === "process" ? S.processing : S.exporting;
  const bar = $("progress-bar") as HTMLProgressElement;
  bar.max = Math.max(total, 1);
  bar.value = done;
  const count = total > 0 ? `${formatCount(done, locale)} / ${formatCount(total, locale)}` : "";
  $("progress-detail").textContent = [count, file].filter(Boolean).join("  ");
}

function hideProgress() {
  currentProgress = null;
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
      status(() => operationError(e));
    }
  }, 400);
}

// ---- operations ------------------------------------------------------------------------

async function startScan(paths: string[], append: boolean) {
  if (m.busy || paths.length === 0) return;
  clearStatus();
  m.busy = "scan";
  m.built = null;
  m.exported = null;
  renderAll();
  showProgress("scan", 0, 0);
  try {
    await api.scan(paths, append);
  } catch (e) {
    m.busy = null;
    hideProgress();
    status(() => operationError(e));
    renderAll();
  }
}

async function build() {
  if (m.busy || !m.summary) return;
  clearStatus();
  pendingPlaceholders = 0;
  m.exported = null;
  await saveNow();
  m.cancelPosters = false;
  let placeholders = 0;
  if (m.settings.includeVideo && m.summary.pendingPosters.length > 0) {
    m.busy = "poster";
    renderActions();
    const run = await capturePosters(
      m.summary.pendingPosters,
      (done, total) => showProgress("poster", done, total),
      () => m.cancelPosters,
    );
    if (run.cancelled) {
      m.busy = null;
      hideProgress();
      status(() => S.cancelled);
      renderActions();
      return;
    }
    placeholders = run.failed;
    // Videos that failed keep the placeholder; do not retry them on the next build in this session.
    m.summary.pendingPosters = [];
  }
  m.busy = "process";
  renderActions();
  showProgress("process", 0, 0);
  try {
    await api.process(m.settings);
    pendingPlaceholders = placeholders;
  } catch (e) {
    m.busy = null;
    hideProgress();
    status(() => operationError(e));
    renderActions();
  }
}

let pendingPlaceholders = 0;

function cancel() {
  m.cancelPosters = true;
  void api.cancel();
}

function onFinish(f: { phase: Phase; ok: boolean; cancelled: boolean; message?: string; code?: string; data?: unknown }) {
  m.busy = null;
  hideProgress();
  if (f.cancelled) {
    status(() => S.cancelled);
  } else if (!f.ok) {
    const code = f.code as MessageCode;
    status(() => `${localizedMessage(locale, code in { busy: 1, cancelled: 1, io: 1, unimplemented: 1, unexpected: 1, other: 1 } ? code : "other")}${f.message ? ` ${f.message}` : ""}`);
  }
  if (f.phase === "import" && f.ok) {
    const imported = f.data as PhotosImportResult;
    if (imported.path && imported.count > 0) void startScan([imported.path], !!m.summary);
    else status(() => S.photosNone);
  } else if (f.phase === "scan" && f.ok) {
    m.summary = f.data as Summary;
  } else if (f.phase === "process" && f.ok) {
    const built = f.data as Built;
    m.built = built;
    m.builtKey = mediaKey(m.settings);
    status(() => [S.built(built.items), ...(built.errorCount ? [S.failedItems(built.errorCount)] : []), ...(pendingPlaceholders > 0 ? [S.placeholders(pendingPlaceholders)] : [])].join(" "));
    loadPreview(built.version);
  } else if (f.phase === "export" && f.ok) {
    const done = f.data as Exported;
    m.exported = { path: done.path, format: m.settings.format };
    m.serveUrl = null;
    void api.serveStop();
    status(() => S.exportedTo(done.bytes));
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

function openPhotosDialog() {
  if (m.busy) return;
  ($("photos-dlg") as HTMLDialogElement).showModal();
}

function bindPhotosDialog() {
  const dlg = $("photos-dlg") as HTMLDialogElement;
  const source = () => document.querySelector<HTMLInputElement>('input[name="photos-source"]:checked')!.value as PhotosImportRequest["source"];
  const update = () => show($("photos-dates"), source() === "range");
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="photos-source"]')) radio.addEventListener("change", update);
  $("photos-open").addEventListener("click", () => void api.openPhotos().catch((e) => status(() => operationError(e))));
  $("photos-cancel").addEventListener("click", () => dlg.close());
  $("photos-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = source();
    const startDay = ($("photos-start") as HTMLInputElement).value;
    const endDay = ($("photos-end") as HTMLInputElement).value;
    if (mode === "range" && (!startDay || !endDay || startDay > endDay)) {
      status(() => S.photosDatesRequired);
      return;
    }
    const request: PhotosImportRequest = {
      source: mode,
      startDay: mode === "range" ? startDay : null,
      endDay: mode === "range" ? endDay : null,
      favoritesOnly: ($("photos-favorites") as HTMLInputElement).checked,
      locationOnly: ($("photos-location") as HTMLInputElement).checked,
    };
    dlg.close();
    clearStatus();
    m.busy = "import";
    renderActions();
    showProgress("import", 0, 0);
    void api.importPhotos(request).catch((err) => {
      m.busy = null;
      hideProgress();
      status(() => operationError(err));
      renderActions();
    });
  });
}

async function startOver() {
  if (m.busy) return;
  await api.serveStop().catch(() => {});
  await api.reset();
  m.summary = null;
  m.built = null;
  m.exported = null;
  m.serveUrl = null;
  clearStatus();
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
  clearStatus();
  m.busy = "export";
  renderActions();
  showProgress("export", 0, 0);
  persist();
  try {
    await api.exportTo(format, out, m.settings);
  } catch (e) {
    m.busy = null;
    hideProgress();
    status(() => operationError(e));
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
    status(() => operationError(e));
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
  $("opt-language").addEventListener("change", (e) => {
    s.language = (e.target as HTMLSelectElement).value as Settings["language"];
    persist(true);
    localize();
  });
  $("opt-export-language").addEventListener("change", (e) => {
    s.exportLanguage = (e.target as HTMLSelectElement).value as Locale;
    changed(true);
    persist(true);
    renderExportDialog();
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
  const [info, settings] = await Promise.all([api.info(), api.getSettings()]);
  m.settings = settings;
  const previousExportLanguage = settings.exportLanguage;
  m.settings.exportLanguage = resolveExportLocale(settings.exportLanguage, resolveAppLocale(settings.language, navigator.language));
  if (previousExportLanguage !== m.settings.exportLanguage) persist(true);
  m.previewUrl = info.previewUrl;
  setProtocolBase(info.previewUrl);
  $("version").textContent = `v${info.version}`;
  show($("btn-photos-library"), info.macos);
  localize();

  bindSettings();
  bindExportDialog();
  bindPhotosDialog();
  $("btn-files").addEventListener("click", () => void addFiles());
  $("btn-folder").addEventListener("click", () => void addFolder());
  $("btn-photos-library").addEventListener("click", openPhotosDialog);
  $("btn-reset").addEventListener("click", () => void startOver());
  $("btn-build").addEventListener("click", () => void build());
  $("btn-export").addEventListener("click", openExport);
  $("btn-cancel").addEventListener("click", cancel);
  $("btn-open").addEventListener("click", () => {
    if (m.exported) void api.openInBrowser(m.exported.path).catch((e) => status(() => operationError(e)));
  });
  $("btn-reveal").addEventListener("click", () => {
    if (m.exported) void api.reveal(m.exported.path).catch((e) => status(() => operationError(e)));
  });
  $("btn-serve").addEventListener("click", () => void toggleServe());

  await onProgress((p) => {
    showProgress(p.phase, p.done, p.total, p.label);
  });
  await onFinished(onFinish);
  await onMenu((id) => {
    if (id === "add-files") void addFiles();
    else if (id === "add-folder") void addFolder();
    else if (id === "import-photos") openPhotosDialog();
    else if (id === "export") openExport();
  });
  await getCurrentWebview().onDragDropEvent((e) => {
    const t = e.payload.type;
    show($("drop-overlay"), t === "enter" || t === "over");
    if (t === "drop") void startScan(e.payload.paths, !!m.summary);
  });
  renderAll();
}

void init().catch((e) => status(() => operationError(e)));
