#!/usr/bin/env node
// Produces the three export outputs the end-to-end suite opens (docs/PLAN.md Wave 2 · G):
// single HTML, bundle folder, and bundle zip (extracted). Layout under <out> (default target/e2e-outputs/current):
//
//   html/photoway.html          single HTML
//   dir/index.html (+ assets)   bundle folder
//   zip/photoway.zip            CLI only
//   zip-extracted/index.html    the zip's contents
//   manifest.json               { source: "cli" | "fallback", ... } read by viewer/tests/e2e
//
// Source of the outputs:
//   cli       `photoway build` (DATA_CONTRACT section 7) on crates/core/tests/data. Binary: PW_CLI, else
//             target/release/photoway[.exe]. Selected only when a probe build works.
//   fallback  the reference layouts of viewer/scripts/make-test-pages.mjs on fixtures/sample (295 items),
//             used while the CLI is missing or still prints "not implemented".
// PW_E2E_REQUIRE_CLI=1 turns a missing/unimplemented CLI into a hard error (set it in CI once Wave 2 · E has landed).
//
//   node scripts/e2e-outputs.mjs [--out DIR]
//   node scripts/e2e-outputs.mjs --shell-only     (just target/size-check/empty-shell.html)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? ".exe" : "";
const defaultCli = join(root, "target", "release", `photoway${exe}`);

const log = (m) => console.log(`[e2e-outputs] ${m}`);

/** Extracts a zip (stored or deflated entries) into `dest`; rejects entries that escape it. */
export function unzip(zipPath, dest) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${zipPath}: not a zip file (no end-of-central-directory record)`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const base = resolve(dest);
  mkdirSync(base, { recursive: true });
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const target = resolve(base, name);
    if (target !== base && !target.startsWith(base + sep)) throw new Error(`zip entry escapes the target folder: ${name}`);
    names.push(name);
    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return names;
}

/** Folder (dest itself or its only child folder) that holds index.html. */
function findIndexRoot(dest) {
  if (existsSync(join(dest, "index.html"))) return dest;
  const kids = readdirSync(dest, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const k of kids) if (existsSync(join(dest, k.name, "index.html"))) return join(dest, k.name);
  throw new Error(`no index.html found in ${dest}`);
}

function locateCli() {
  const env = process.env.PW_CLI;
  if (env) {
    if (!existsSync(env)) throw new Error(`PW_CLI points to a missing file: ${env}`);
    return resolve(env);
  }
  return existsSync(defaultCli) ? defaultCli : null;
}

function runCli(cli, args) {
  return spawnSync(cli, args, { encoding: "utf8", timeout: 120_000 });
}

/** Returns { cli, reason }: cli is a path when `photoway build` works, else null with the reason. */
function probeCli() {
  const cli = locateCli();
  if (!cli) return { cli: null, reason: `no photoway binary (PW_CLI unset, ${defaultCli} missing)` };
  const probeDir = join(root, "target", "e2e-outputs", "probe");
  rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(probeDir, { recursive: true });
  const r = runCli(cli, ["build", join(root, "crates", "core", "tests", "data"), "-o", join(probeDir, "probe.html")]);
  if (r.status === 0 && existsSync(join(probeDir, "probe.html"))) return { cli, reason: "" };
  const msg = `${r.error?.message ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] || `exit ${r.status}`;
  return { cli: null, reason: `${cli} cannot build: ${msg}` };
}

async function loadPageBuilder() {
  const mod = await import(pathToFileURL(join(root, "viewer", "scripts", "make-test-pages.mjs")).href);
  return mod;
}

function ensureViewerDist() {
  const dist = join(root, "viewer", "dist");
  for (const f of ["viewer.js", "viewer.css", "template.html", "world.topo.json"]) {
    if (!existsSync(join(dist, f))) throw new Error(`viewer/dist/${f} is missing; run "npm run build -w viewer" first`);
  }
  return dist;
}

function ensureSampleProject() {
  const p = join(root, "fixtures", "sample", "project.json");
  if (!existsSync(p)) {
    const r = spawnSync(process.execPath, [join(root, "scripts", "gen-sample-data.mjs")], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("gen-sample-data.mjs failed");
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Writes target/size-check/empty-shell.html: the viewer template filled with a zero-item project. */
export async function writeEmptyShell() {
  const dist = ensureViewerDist();
  const { buildPages } = await loadPageBuilder();
  const tmp = join(root, "target", "e2e-outputs", "shell");
  const project = { ...ensureSampleProject(), title: "Empty", items: [], options: { theme: "auto", basemap: "offline", outlierSpeedKmh: 300 } };
  const r = buildPages({ project, dist, out: tmp });
  mkdirSync(join(root, "target", "size-check"), { recursive: true });
  cpSync(r.single, join(root, "target", "size-check", "empty-shell.html"));
  return join(root, "target", "size-check", "empty-shell.html");
}

export async function prepareOutputs({ out = join(root, "target", "e2e-outputs", "current") } = {}) {
  const requireCli = process.env.PW_E2E_REQUIRE_CLI === "1";
  const { cli, reason } = probeCli();
  if (!cli && requireCli) throw new Error(`PW_E2E_REQUIRE_CLI=1 but the CLI is unusable: ${reason}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const manifest = { source: cli ? "cli" : "fallback", cli, note: reason, outputs: {} };
  if (cli) {
    log(`source = CLI (${cli})`);
    const input = join(root, "crates", "core", "tests", "data");
    const common = ["--title", "E2E fixture", "--basemap", "offline", "--theme", "auto"];
    const build = (format, target) => {
      const r = runCli(cli, ["build", input, "-o", target, "--format", format, ...common]);
      if (r.status !== 0) throw new Error(`photoway build --format ${format} failed: ${r.stderr}`);
    };
    mkdirSync(join(out, "html"), { recursive: true });
    mkdirSync(join(out, "zip"), { recursive: true });
    build("html", join(out, "html", "photoway.html"));
    build("dir", join(out, "dir"));
    build("zip", join(out, "zip", "photoway.zip"));
    const names = unzip(join(out, "zip", "photoway.zip"), join(out, "zip-extracted"));
    log(`zip holds ${names.length} entries`);
    manifest.outputs = {
      html: { file: join(out, "html", "photoway.html") },
      dir: { file: join(findIndexRoot(join(out, "dir")), "index.html") },
      zip: { file: join(findIndexRoot(join(out, "zip-extracted")), "index.html"), archive: join(out, "zip", "photoway.zip") },
    };
  } else {
    log(`source = FALLBACK reference layouts (${reason})`);
    if (process.env.CI) console.warn("::warning::e2e outputs came from the fallback layouts, not the photoway CLI");
    const dist = ensureViewerDist();
    const { buildPages } = await loadPageBuilder();
    const project = ensureSampleProject();
    project.options = { ...project.options, basemap: "offline" };
    const r = buildPages({ project, dist, out: join(out, "_build") });
    mkdirSync(join(out, "html"), { recursive: true });
    cpSync(r.single, join(out, "html", "photoway.html"));
    cpSync(join(out, "_build", "bundle"), join(out, "dir"), { recursive: true });
    cpSync(join(out, "_build", "bundle"), join(out, "zip-extracted"), { recursive: true }); // stands in for an unzipped archive
    rmSync(join(out, "_build"), { recursive: true, force: true });
    manifest.outputs = {
      html: { file: join(out, "html", "photoway.html") },
      dir: { file: join(out, "dir", "index.html") },
      zip: { file: join(out, "zip-extracted", "index.html"), archive: null },
    };
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeEmptyShell();
  return { manifest, out };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  if (process.argv.includes("--shell-only")) {
    log(`wrote ${await writeEmptyShell()}`);
  } else {
    const { manifest, out } = await prepareOutputs(i >= 0 ? { out: resolve(process.argv[i + 1]) } : {});
    log(`source=${manifest.source}; outputs in ${out}`);
  }
}
