// Every user-visible string of the app shell lives here.

export const S = {
  dropHint: "Drop photos, videos or folders here",
  addPhotos: "Add photos...",
  addFolder: "Add folder...",
  dropOverlay: "Drop to add",
  summaryTitle: "Found",
  startOver: "Start over",
  optionsTitle: "Options",
  optTitle: "Title",
  optFull: "Full-size photos",
  fullNone: "None (thumbnails only)",
  fullWeb: "Web size",
  fullOriginal: "Original files",
  optEdge: "Web size, long edge",
  optVideo: "Include videos",
  optExif: "Strip EXIF metadata",
  optPrecision: "Coordinate precision",
  optBasemap: "Default basemap",
  optTheme: "Default theme",
  cancel: "Cancel",
  exportButton: "Export...",
  resultTitle: "Exported",
  openBrowser: "Open in browser",
  reveal: "Reveal",
  serve: "Serve",
  serveStop: "Stop serving",
  emptyTitle: "Your route map appears here",
  emptyBody: "Add geotagged photos or videos to begin. Everything stays on your computer.",
  exportTitle: "Export",
  fmtHtml: "Single HTML file",
  fmtHtmlHint: "One file to share. Best for a few hundred photos.",
  fmtDir: "Folder",
  fmtDirHint: "index.html with its assets. Best for large trips.",
  fmtZip: "Zip",
  fmtZipHint: "The folder, zipped for sending.",
  exportGo: "Export",

  build: "Build preview",
  rebuild: "Rebuild preview",
  stale: "Media options changed. Rebuild to apply them.",
  scanning: "Scanning",
  capturing: "Capturing video previews",
  processing: "Preparing media",
  exporting: "Exporting",
  dateRangeSame: (d: string) => `Taken on ${d}`,
  dateRange: (a: string, b: string) => `Taken ${a} to ${b}`,
  noDates: "No capture dates found",
  foundMain: (withLoc: number, found: number) =>
    `${plural(withLoc, "item")} with a location, out of ${plural(found, "file")}`,
  kinds: (photos: number, videos: number, live: number) => {
    const parts = [`${plural(photos, "photo")}`, `${plural(videos, "video")}`];
    if (live) parts.push(`${plural(live, "Live Photo")}`);
    return parts.join(", ");
  },
  skipped: (n: number) => `${plural(n, "file")} skipped`,
  nothingFound: "No geotagged photos or videos found. Check that the originals still carry location data.",
  built: (items: number) => `${plural(items, "item")} on the map`,
  failedItems: (n: number) => `${plural(n, "file")} could not be processed and show a placeholder.`,
  placeholders: (n: number) => `${plural(n, "video")} could not be previewed here and use a placeholder.`,
  estimate: (bytes: number) => (bytes > 0 ? `about ${formatBytes(bytes)}` : "size unknown"),
  bigHtml: (bytes: number) =>
    `A single file of ${formatBytes(bytes)} can be slow to open. A folder or zip is a better choice for this trip.`,
  noPreview: "Preview unavailable",
  exportedTo: (bytes: number) => `${formatBytes(bytes)} written`,
  serving: (url: string) => `Serving at ${url}`,
  cancelled: "Cancelled.",
  precisionFull: "Full (exact)",
  precisionDecimals: (d: number, approx: string) => `${d} decimals (about ${approx})`,
  edgeOption: (px: number) => `${px} px`,
  basemaps: [
    ["auto", "Automatic"],
    ["offline", "Offline world"],
    ["satellite", "Satellite"],
    ["satellite-labels", "Satellite with labels"],
    ["topo", "Topographic"],
    ["osm", "OpenStreetMap"],
    ["terrain", "Terrain"],
  ] as const,
  themes: [
    ["auto", "Automatic"],
    ["light", "Light"],
    ["dark", "Dark"],
    ["dusk", "Dusk"],
    ["paper", "Paper"],
    ["forest", "Forest"],
  ] as const,
  pickerPhotos: "Photos and videos",
  pickerTitleFiles: "Add photos or videos",
  pickerTitleFolder: "Add a folder",
  saveHtml: "Save single HTML",
  saveZip: "Save zip",
  saveDir: "Choose where to create the folder",
};

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
