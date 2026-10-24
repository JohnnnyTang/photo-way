// Keeps every version field in the repo in step.
//   node scripts/version-sync.mjs 0.2.0      write the version everywhere
//   node scripts/version-sync.mjs --check    exit 1 unless all versions agree
//   node scripts/version-sync.mjs --check v0.2.0   ...and also equal this tag (leading "v" is ignored)
// Touches: Cargo.toml [workspace.package], Cargo.lock (workspace members only), root/viewer/app package.json,
// package-lock.json (workspace entries), app/src-tauri/tauri.conf.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (f) => resolve(root, f);
const read = (f) => readFileSync(p(f), "utf8");
const write = (f, s) => writeFileSync(p(f), s);
const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const members = ["photoway-core", "photoway-cli", "photoway-app"];
const jsonFiles = ["package.json", "viewer/package.json", "app/package.json", "app/src-tauri/tauri.conf.json"];

// Every location as { label, get(), set(v) }.
function locations() {
  const out = [];
  out.push({
    label: "Cargo.toml [workspace.package]",
    get: () => /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(read("Cargo.toml"))?.[1],
    set: (v) =>
      write("Cargo.toml", read("Cargo.toml").replace(/(\[workspace\.package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${v}$2`)),
  });
  for (const m of members) {
    const re = new RegExp(`(\\[\\[package\\]\\]\\nname = "${m}"\\nversion = ")([^"]+)(")`);
    out.push({
      label: `Cargo.lock ${m}`,
      get: () => re.exec(read("Cargo.lock"))?.[2],
      set: (v) => write("Cargo.lock", read("Cargo.lock").replace(re, `$1${v}$3`)),
    });
  }
  for (const f of jsonFiles) {
    out.push({
      label: f,
      get: () => JSON.parse(read(f)).version,
      // Text replace of the first top-level "version" so formatting is preserved.
      set: (v) => {
        const s = read(f);
        const re = /^(\s*"version":\s*")[^"]*(")/m;
        write(f, re.test(s) ? s.replace(re, `$1${v}$2`) : s.replace(/^(\s*"name":.*\n)/m, `$1  "version": "${v}",\n`));
      },
    });
  }
  const lockPaths = ["", "viewer", "app", "node_modules/@photoway/viewer", "node_modules/@photoway/app"];
  for (const k of lockPaths) {
    const entry = () => JSON.parse(read("package-lock.json")).packages?.[k];
    out.push({
      label: `package-lock.json packages["${k}"]`,
      // The root entry has no version until package.json gains one; "node_modules/@photoway/*" are links.
      get: () => (entry()?.link ? undefined : entry()?.version),
      set: (v) => {
        const lock = JSON.parse(read("package-lock.json"));
        if (lock.packages?.[k] && !lock.packages[k].link) {
          if (k === "") {
            // Keep key order sensible: name, version first.
            const { name, version: _old, ...rest } = lock.packages[""];
            lock.packages[""] = { name, version: v, ...rest };
          } else {
            lock.packages[k].version = v;
          }
        }
        write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
      },
    });
  }
  return out;
}

const args = process.argv.slice(2);
const strip = (v) => v?.replace(/^v/, "");
if (args[0] === "--check") {
  const want = strip(args[1]);
  const seen = locations().map((l) => ({ label: l.label, v: l.get() }));
  const known = seen.filter((s) => s.v !== undefined);
  const base = want ?? known[0].v;
  const bad = known.filter((s) => s.v !== base);
  if (want && !semver.test(want)) bad.push({ label: "argument", v: want });
  console.log(known.map((s) => `${s.v.padEnd(10)} ${s.label}`).join("\n"));
  if (bad.length) {
    console.error(`\nVersion mismatch (expected ${base}):\n${bad.map((s) => `  ${s.label}: ${s.v}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nAll ${known.length} versions agree: ${base}`);
} else if (args[0] && !args[0].startsWith("-")) {
  const v = strip(args[0]);
  if (!semver.test(v)) {
    console.error(`Not a semver version: ${args[0]}`);
    process.exit(2);
  }
  for (const l of locations()) l.set(v);
  console.log(`Set version ${v} in ${locations().length} places. Review with: git diff --stat`);
} else {
  console.error("Usage: node scripts/version-sync.mjs <version> | --check [version]");
  process.exit(2);
}
