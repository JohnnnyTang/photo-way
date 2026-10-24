import { defineConfig } from "vite";

// Output must be a classic script: Chrome refuses `type="module"` from file://.
export default defineConfig({
  // Dev server serves repo fixtures at / (e.g. /sample/data.js); never copied into dist.
  publicDir: "../fixtures",
  build: {
    copyPublicDir: false,
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: "src/main.ts",
      name: "PhotoWay",
      formats: ["iife"],
      fileName: () => "viewer.js",
      cssFileName: "viewer",
    },
  },
});
