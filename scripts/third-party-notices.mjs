// Generates THIRD_PARTY_NOTICES.md: the statically linked C libraries (libheif, libde265;
// LGPL-3.0) with source / relinking information, plus every Rust crate in the dependency
// graph with its licence (from `cargo metadata`).
//
// Usage: node scripts/third-party-notices.mjs [--check]
//   --check   exit 1 when THIRD_PARTY_NOTICES.md is out of date (no write)
//
// JavaScript dependencies of viewer/ and app/ are bundled into the shipped HTML/JS and are
// covered by their own notice step (Wave 3 / release hardening).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NL = String.fromCharCode(10);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "THIRD_PARTY_NOTICES.md");

const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }),
);
const members = new Set(meta.workspace_members);
const crates = meta.packages
  .filter((p) => !members.has(p.id))
  .map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license ?? (p.license_file ? `see ${p.license_file}` : "UNKNOWN"),
    repo: p.repository ?? "",
  }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const unknown = crates.filter((c) => c.license === "UNKNOWN");
if (unknown.length) {
  console.error(`Crates without licence metadata: ${unknown.map((c) => c.name).join(", ")}`);
  process.exit(1);
}

const vcpkgTag = (readFileSync(join(root, "scripts", "setup-libheif.sh"), "utf8").match(/VCPKG_TAG=(\S+)/) ?? [])[1];

const head = [
  "# Third-party notices",
  "",
  "Photo Way is MIT-licensed (see `LICENSE`). It includes the following third-party software.",
  "",
  "## Statically linked C libraries (LGPL-3.0)",
  "",
  "**This program uses libheif and libde265 to decode HEIC/HEIF images. Both libraries are",
  "licensed under the GNU Lesser General Public License, version 3 (LGPL-3.0-only).** They are",
  "linked statically into the Photo Way application and command-line tool.",
  "",
  "| Library | Version | Licence | Copyright |",
  "|---|---|---|---|",
  "| libheif | 1.23.5 | LGPL-3.0-only (sample apps and wrappers: MIT) | Struktur AG, Dirk Farin |",
  "| libde265 | 1.1.3 | LGPL-3.0-only (sample apps: MIT; `win32cond.c`: DOC licence) | Struktur AG, Dirk Farin |",
  "",
  "Full licence texts: `licenses/LGPL-3.0.txt` and `licenses/GPL-3.0.txt` (the LGPL is",
  "supplemental to the GPL). The vcpkg `copyright` files of both ports are shipped next to",
  "them in release bundles.",
  "",
  "Only the HEVC *decoder* is included; no GPL-licensed codec (x265, x264) is linked.",
  "",
  "### Source code and relinking (LGPL-3.0 section 4)",
  "",
  "You may modify these libraries and relink Photo Way against your version. Because they are",
  "linked statically, the complete corresponding source needed to do that is public:",
  "",
  "- **Photo Way source** (MIT, with `Cargo.lock`): https://github.com/JohnnnyTang/photo-way",
  `- **Library sources, as built:** libheif and libde265 are built from the vcpkg ports pinned at tag \`${vcpkgTag ?? "?"}\` of https://github.com/microsoft/vcpkg (\`ports/libheif\`, \`ports/libde265\`, including their patches), using the overlay triplets in \`vcpkg/triplets/\`. Every GitHub Release also attaches \`third-party-sources-<version>.tar.gz\` with the exact source tarballs, port files and triplets.`,
  "- **How to rebuild:** run `scripts/setup-libheif.ps1` (Windows) or `scripts/setup-libheif.sh` (macOS)",
  "  with `VCPKG_ROOT` pointing at a vcpkg tree whose `libheif`/`libde265` ports you changed (or edit",
  "  the checked-out sources), then `cargo build --release`. See `docs/BUILDING.md`.",
  "",
  "Nothing in Photo Way's terms forbids modification or reverse engineering for your own use.",
  "",
  "## Rust crates",
  "",
  `${crates.length} crates in the dependency graph (generated from \`cargo metadata\`; build-only and platform-specific crates are included).`,
  "",
  "| Crate | Version | Licence | Source |",
  "|---|---|---|---|",
];
const rows = crates.map((c) => `| ${c.name} | ${c.version} | ${c.license.replaceAll("|", "/")} | ${c.repo} |`);
const text = head.concat(rows, [""]).join(NL);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {}
  if (current.replaceAll(String.fromCharCode(13), "") !== text) {
    console.error("THIRD_PARTY_NOTICES.md is out of date: run node scripts/third-party-notices.mjs");
    process.exit(1);
  }
  console.log("THIRD_PARTY_NOTICES.md is up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (${crates.length} crates)`);
}
