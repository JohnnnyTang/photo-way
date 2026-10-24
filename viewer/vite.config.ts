import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

/**
 * MapLibre 6 ships its worker only as an ES module, and a module worker started from a blob: URL fails on
 * file:// in Chromium and WebKit (docs/spikes/S2-file-protocol.md). This exposes the worker source as a string
 * with the trailing `export{...}` removed, so the viewer can start it as a classic blob worker.
 */
function maplibreClassicWorker(): Plugin {
  const ID = "virtual:maplibre-worker";
  return {
    name: "maplibre-classic-worker",
    resolveId: (id) => (id === ID ? "\0" + ID : null),
    load(id) {
      if (id !== "\0" + ID) return null;
      let src = readFileSync(require.resolve("maplibre-gl/dist/maplibre-gl-worker.mjs"), "utf8").replace(
        /\n\/\/# sourceMappingURL=\S+\s*$/,
        "\n",
      );
      const before = src.length;
      src = src.replace(/export\s*\{\s*\w+\s+as\s+default\s*\}\s*;?\s*$/, "\n");
      if (src.length === before) throw new Error("maplibre worker: trailing export not found (MapLibre changed?)");
      new vm.Script(src); // fails the build when any import/export is left
      return `export default ${JSON.stringify(src)};`;
    },
  };
}

function devBasemap(): Plugin {
  return {
    name: "dev-inline-basemap",
    transformIndexHtml(html) {
      const basemap = readFileSync(new URL("./basemap/world.topo.json", import.meta.url), "utf8");
      return html.replace("</body>", `<script id="pw-basemap" type="application/json">${basemap}</script></body>`);
    },
  };
}

// Output must be a classic script: no ES modules at runtime (file:// friendly).
export default defineConfig({
  plugins: [maplibreClassicWorker(), devBasemap()],
  test: { include: ["tests/unit/**/*.test.ts"] },
  // Dev server serves repo fixtures at / (e.g. /sample/data.js); never copied into dist.
  publicDir: "../fixtures",
  build: {
    copyPublicDir: false,
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rolldownOptions: { transform: { define: { "import.meta": "{}" } } },
    lib: {
      entry: "src/main.ts",
      name: "PhotoWay",
      formats: ["iife"],
      fileName: () => "viewer.js",
      cssFileName: "viewer",
    },
  },
});
