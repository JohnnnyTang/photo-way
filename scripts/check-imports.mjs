// Binary import assertion (docs/spikes/S1-heic.md, "Open items"): release binaries must depend only on
// OS-provided libraries, so end users install nothing.
//   Windows: dumpbin /dependents. Fails on VCRUNTIME*/MSVCP*/CONCRT*/VCOMP* (the VC++ redistributable) and on any
//            DLL that is not an api-ms-win-* forwarder or present in %SystemRoot%\System32.
//   macOS:   otool -L (every slice). Fails on anything outside /usr/lib/ and /System/.
// Usage: node scripts/check-imports.mjs <binary> [<binary> ...]
// Other hosts print a note and exit 0 (the Linux job links distro libheif dynamically on purpose).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/check-imports.mjs <binary> [<binary> ...]");
  process.exit(2);
}

const forbiddenWin = /^(vcruntime|msvcp|concrt|vcomp|vccorlib|msvcr)\d*/i;

function findDumpbin() {
  if (process.env.DUMPBIN && existsSync(process.env.DUMPBIN)) return process.env.DUMPBIN;
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(pf86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const vs = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], { encoding: "utf8" }).trim();
  const msvc = join(vs, "VC", "Tools", "MSVC");
  for (const ver of readdirSync(msvc).sort().reverse()) {
    const p = join(msvc, ver, "bin", "Hostx64", "x64", "dumpbin.exe");
    if (existsSync(p)) return p;
  }
  throw new Error("dumpbin.exe not found; set DUMPBIN to its path");
}

function windowsDeps(file) {
  const out = execFileSync(findDumpbin(), ["/nologo", "/dependents", file], { encoding: "utf8" });
  return [...out.matchAll(/^\s+(\S+\.dll)\s*$/gim)].map((m) => m[1]);
}

function checkWindows(file) {
  const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const problems = [];
  const deps = windowsDeps(file);
  for (const d of deps) {
    if (forbiddenWin.test(d)) problems.push(`${d}: VC++ runtime must be linked statically`);
    else if (!/^api-ms-win-/i.test(d) && !existsSync(join(sys32, d))) problems.push(`${d}: not an OS DLL (not in System32)`);
  }
  return { deps, problems };
}

function checkMac(file) {
  const out = execFileSync("otool", ["-L", file], { encoding: "utf8" });
  const deps = [...out.matchAll(/^\s+(\S+) \(compatibility version/gm)].map((m) => m[1]);
  const problems = deps.filter((d) => !d.startsWith("/usr/lib/") && !d.startsWith("/System/")).map((d) => `${d}: not an OS library`);
  return { deps: [...new Set(deps)], problems };
}

let failed = false;
for (const file of files) {
  let res;
  if (process.platform === "win32") res = checkWindows(file);
  else if (process.platform === "darwin") res = checkMac(file);
  else {
    console.log(`check-imports: skipped on ${process.platform} (${file})`);
    continue;
  }
  console.log(`${file}\n  ${res.deps.join("\n  ")}`);
  if (res.problems.length) {
    failed = true;
    console.error(`FAIL ${file}\n  ${res.problems.join("\n  ")}`);
  } else {
    console.log(`OK   ${file}: ${res.deps.length} imports, all OS-provided`);
  }
}
process.exit(failed ? 1 : 0);
