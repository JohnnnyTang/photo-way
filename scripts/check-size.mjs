// Enforces the size budgets in scripts/budgets.json (docs/PLAN.md section 2.1).
// Usage: node scripts/check-size.mjs [--only id,id] [--require]
//   --only     check just these budget ids (viewer, basemap, shell, installer, output-html, output-dir, output-zip)
//   --require  fail when a selected budget matches no files (default: skip it)
// The "shell" budget looks for target/size-check/empty-shell.html and the output-* budgets for the fixture builds;
// both are written by `node scripts/e2e-outputs.mjs` (the end-to-end suite runs it).
import { readFileSync, globSync, appendFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const require = args.includes("--require");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(",") : null;

const { budgets } = JSON.parse(readFileSync(resolve(root, "scripts/budgets.json"), "utf8"));
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

const rows = [];
let failed = false;
for (const b of budgets) {
  if (only && !only.includes(b.id)) continue;
  const files = [...new Set(b.globs.flatMap((g) => globSync(g, { cwd: root })))]
    .filter((f) => statSync(resolve(root, f)).isFile())
    .map((f) => f.replaceAll("\\", "/"))
    .sort();
  if (files.length === 0) {
    if (require) failed = true;
    rows.push([b.id, "(no files)", "-", b.label, require ? "MISSING" : "skipped"]);
    continue;
  }
  const measure = (list) => {
    const bufs = list.map((f) => readFileSync(resolve(root, f)));
    const size = bufs.reduce((n, x) => n + x.length, 0);
    const gz = b.maxGzipBytes ? bufs.reduce((n, x) => n + gzipSync(x, { level: 9 }).length, 0) : null;
    return { size, gz };
  };
  const groups = b.each ? files.map((f) => [f]) : [files];
  for (const g of groups) {
    const { size, gz } = measure(g);
    const over = size > b.maxBytes || (gz !== null && gz > b.maxGzipBytes);
    if (over) failed = true;
    const limit = `${kb(b.maxBytes)}${b.maxGzipBytes ? ` / ${kb(b.maxGzipBytes)} gz` : ""}`;
    const actual = `${kb(size)}${gz !== null ? ` / ${kb(gz)} gz` : ""}`;
    rows.push([b.each ? g[0] : b.id, actual, limit, b.label, over ? "OVER" : "ok"]);
  }
}

const header = ["budget", "actual", "limit", "what", "status"];
console.log([header, ...rows].map((r) => r.join("  |  ")).join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [header, header.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Size budgets\n\n${md}\n\n`);
}
if (failed) {
  console.error("Size budget check failed.");
  process.exit(1);
}
