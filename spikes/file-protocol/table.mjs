// Markdown tables from out/results.json for the S2 report.
import { readFileSync } from "node:fs";
const R = JSON.parse(readFileSync(new URL("./out/results.json", import.meta.url), "utf8"));
const B = ["chromium", "chrome", "msedge", "firefox", "webkit"].filter((b) => R[b]);
const S = ["offline", "offline-modworker", "offline-v5", "globe", "esri", "osm", "terrain", "terrain-offline", "globe-terrain", "thumbs", "bundle", "save"];
const cell = (x, s) => {
  if (!x) return "–";
  if (!x.ok) return "**FAIL**";
  if (s.startsWith("terrain") || s === "globe-terrain") return `✅ ${Math.round(x.elevationM)} m`;
  if (s === "esri" || s === "osm") return `✅ ${x.tiles?.raster} tiles`;
  if (s === "thumbs" || s === "bundle") return `✅ ${x.zoomed?.imgsDecoded}/${x.zoomed?.imgs}`;
  if (s === "save") return `✅${x.noGesture?.download?.ok ? "" : " (gesture only)"}`;
  return "✅";
};
console.log("| scenario | " + B.flatMap((b) => [`${b} file://`, `${b} http`]).join(" | ") + " |");
console.log("|---|" + B.flatMap(() => ["---", "---"]).join("|") + "|");
for (const s of S) console.log(`| ${s} | ` + B.flatMap((b) => ["file", "http"].map((p) => cell(R[b][p]?.[s], s))).join(" | ") + " |");
console.log("\nversions:", B.map((b) => `${b} ${R[b].version}`).join(", "));
console.log("\n| first idle ms (file://) | " + B.join(" | ") + " |\n|---|" + B.map(() => "---").join("|") + "|");
for (const s of ["offline", "offline-v5", "thumbs", "bundle"]) console.log(`| ${s} | ` + B.map((b) => R[b].file?.[s]?.ms?.firstIdle ?? "–").join(" | ") + " |");
console.log("\n| DOMContentLoaded ms (file://) | " + B.join(" | ") + " |\n|---|" + B.map(() => "---").join("|") + "|");
for (const s of ["offline", "thumbs"]) console.log(`| ${s} | ` + B.map((b) => R[b].file?.[s]?.ms?.domContentLoaded ?? "–").join(" | ") + " |");
