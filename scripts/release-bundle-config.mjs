// Build a Tauri config overlay that places licence files in every installer/app bundle.
// Usage: node scripts/release-bundle-config.mjs [--require-lgpl]
// A manual dry run before Wave 1 B can include only LICENSE. Tagged releases require all notices.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/LGPL-3.0.txt", "licenses/GPL-3.0.txt"];
const missing = required.filter((path) => !existsSync(resolve(root, path)) || statSync(resolve(root, path)).size === 0);
if (missing.includes("LICENSE") || (process.argv.includes("--require-lgpl") && missing.length)) {
  console.error(`Release licence files missing: ${missing.join(", ")}`);
  process.exit(1);
}

const resources = { "../../LICENSE": "LICENSE" };
if (!missing.includes("THIRD_PARTY_NOTICES.md")) {
  resources["../../THIRD_PARTY_NOTICES.md"] = "THIRD_PARTY_NOTICES.md";
}
if (existsSync(resolve(root, "licenses"))) {
  resources["../../licenses/"] = "licenses/";
}
const path = resolve(root, "app/src-tauri/release-bundle.config.json");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify({ bundle: { resources } }, null, 2) + "\n");
console.log(`Wrote ${path} with ${Object.keys(resources).length} resources`);
