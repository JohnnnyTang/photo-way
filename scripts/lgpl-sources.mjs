// Builds the LGPL-3.0 corresponding-source bundle (docs/spikes/S1-heic.md, "Licensing", item 4):
//   third-party-sources-<version>.tar.gz containing
//     sources/libheif-<v>.tar.gz, sources/libde265-<v>.tar.gz   exact upstream sources (SHA-512 verified against the port)
//     vcpkg/ports/libheif, vcpkg/ports/libde265                  port files and patches applied at the pinned tag
//     vcpkg/triplets/                                            our overlay triplets
//     BUILDING.txt                                               how to rebuild and relink
// Usage: node scripts/lgpl-sources.mjs --version 0.1.0 [--vcpkg-tag 2026.10.16] [--out dist-release]
// Uses $VCPKG_ROOT if it is a checkout of the right tag, otherwise clones the tag into a temp dir.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const version = arg("version");
if (!version) {
  console.error("Usage: node scripts/lgpl-sources.mjs --version <app version> [--vcpkg-tag T] [--out DIR]");
  process.exit(2);
}
const tag = arg("vcpkg-tag", process.env.VCPKG_TAG ?? "2026.10.16");
const outDir = resolve(arg("out", join(root, "dist-release")));
const ports = ["libheif", "libde265"];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

// 1. A vcpkg tree at the pinned tag.
let vcpkg = process.env.VCPKG_ROOT;
const tagOk = (dir) => {
  try {
    return (
      existsSync(join(dir, "ports", "libheif", "portfile.cmake")) &&
      execFileSync("git", ["-C", dir, "describe", "--tags", "--exact-match"], { encoding: "utf8" }).trim() === tag
    );
  } catch {
    return false;
  }
};
if (!vcpkg || !tagOk(vcpkg)) {
  vcpkg = join(mkdtempSync(join(tmpdir(), "vcpkg-")), "vcpkg");
  run("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", tag, "https://github.com/microsoft/vcpkg", vcpkg]);
}

// 2. Stage the bundle.
const name = `third-party-sources-${version}`;
const stage = join(mkdtempSync(join(tmpdir(), "lgpl-")), name);
mkdirSync(join(stage, "sources"), { recursive: true });
mkdirSync(join(stage, "vcpkg", "ports"), { recursive: true });
const manifest = [];

for (const port of ports) {
  const portDir = join(vcpkg, "ports", port);
  const portfile = readFileSync(join(portDir, "portfile.cmake"), "utf8");
  const vjson = JSON.parse(readFileSync(join(portDir, "vcpkg.json"), "utf8"));
  const ver = vjson.version ?? vjson["version-semver"] ?? vjson["version-string"];
  const repo = /REPO\s+(\S+)/.exec(portfile)?.[1];
  const ref = /REF\s+"?([^"\s)]+)"?/.exec(portfile)?.[1]?.replace("${VERSION}", ver);
  const sha512 = /SHA512\s+([0-9a-f]{128})/.exec(portfile)?.[1];
  if (!repo || !ref || !sha512 || !ver) throw new Error(`Cannot parse port ${port} (repo=${repo} ref=${ref} version=${ver})`);

  const url = `https://github.com/${repo}/archive/${ref}.tar.gz`;
  console.log(`fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha512").update(buf).digest("hex");
  if (got !== sha512) throw new Error(`${port}: SHA-512 mismatch (port ${sha512}, downloaded ${got})`);
  writeFileSync(join(stage, "sources", `${port}-${ver}.tar.gz`), buf);

  cpSync(portDir, join(stage, "vcpkg", "ports", port), { recursive: true });
  manifest.push(`${port} ${ver}  ${url}  sha512=${sha512}`);
}
cpSync(join(root, "vcpkg", "triplets"), join(stage, "vcpkg", "triplets"), { recursive: true });

writeFileSync(
  join(stage, "BUILDING.txt"),
  [
    `Photo Way ${version}: corresponding source for the LGPL-3.0 libraries linked into its binaries`,
    "",
    "Photo Way statically links libheif and libde265 (both LGPL-3.0) for HEIC decoding. This archive contains the",
    "exact sources, the vcpkg port files and patches used to build them, and our vcpkg overlay triplets.",
    "The application's own source is MIT-licensed and public: https://github.com/JohnnnyTang/photo-way",
    "",
    "Contents",
    ...manifest.map((m) => `  ${m}`),
    `  vcpkg tag: ${tag} (https://github.com/microsoft/vcpkg/tree/${tag})`,
    "",
    "Rebuild with a modified library",
    "  1. Check out the Photo Way source for this version (tag v" + version + ") and Cargo.lock.",
    `  2. git clone --branch ${tag} https://github.com/microsoft/vcpkg and bootstrap it.`,
    "  3. Replace the library source: unpack sources/<lib>-<version>.tar.gz, edit it, and point the port at your copy",
    "     (copy vcpkg/ports/<lib> into an overlay-ports directory and change vcpkg_from_github to use SOURCE_PATH),",
    "     then run:",
    "       vcpkg install libheif[core]:<triplet> --overlay-triplets=<repo>/vcpkg/triplets --overlay-ports=<your ports>",
    "     with triplet x64-windows-static-rel (Windows), arm64-osx-pw or x64-osx-pw (macOS).",
    "  4. Build as described in the repository's scripts/setup-libheif.{sh,ps1} and docs/BUILDING.md.",
    "",
  ].join("\n"),
);

mkdirSync(outDir, { recursive: true });
const archive = join(outDir, `${name}.tar.gz`);
run("tar", ["-czf", `${name}.tar.gz`, "-C", dirname(stage), name], { cwd: outDir });
console.log(`wrote ${archive}`);
