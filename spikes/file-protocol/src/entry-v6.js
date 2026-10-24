// Vite IIFE entry for MapLibre GL JS 6.x — the pattern the real viewer (Wave 1) would use.
// v6 is ESM-only and loads its worker from a separate file (maplibre-gl-worker.mjs). From file://
// there is no worker *file* we can load, so the worker source is inlined as a string
// (virtual:maplibre-worker, see build-pages.mjs) and handed to MapLibre as a blob: URL.
//
// __WORKER_MODE__ (Vite define):
//   "classic" (recommended): the worker source has its trailing `export{…}` stripped at build time and the
//             URL ends in ".cjs" (as a fragment), which MapLibre >= 6.15.0 takes as "start a classic worker".
//   "module"  (naive): blob URL of the untouched ESM worker -> MapLibre starts a module worker.
import * as maplibregl from "maplibre-gl";
import workerSource from "virtual:maplibre-worker";
import "maplibre-gl/dist/maplibre-gl.css";
import { feature } from "topojson-client";
import "./spike.css";
import "./app.js";

// Never revoke this URL: the worker pool re-creates workers after all maps are removed.
const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
maplibregl.setWorkerUrl(__WORKER_MODE__ === "classic" ? blobUrl + "#maplibre-gl-worker.cjs" : blobUrl);

function boot() { window.SpikeApp.start(maplibregl, feature); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
