#!/usr/bin/env node
// Smoke test of release assets on a clean host (Windows or macOS). Used by .github/workflows/release-smoke.yml and
// runnable locally (it installs and uninstalls software; use a VM on Windows).
//
//   node scripts/release-smoke.mjs --tag v0.1.0 --dir <folder with the downloaded assets> [--work <scratch dir>]
//
// File associations: Photo Way registers none (no fileAssociations in tauri.conf.json). The script asserts that the
// installers add no extension keys on Windows and no CFBundleDocumentTypes on macOS.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BS = String.fromCharCode(92);
const win = process.platform === "win32";
const mac = process.platform === "darwin";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const tag = opt("tag");
const dir = opt("dir") && resolve(opt("dir"));
if (!tag || !dir) {
  console.error("usage: release-smoke.mjs --tag vX.Y.Z --dir <assets folder> [--work <scratch>]");
  process.exit(2);
}
const version = tag.replace(/^v/, "");
const work = opt("work") ? resolve(opt("work")) : mkdtempSync(join(tmpdir(), "pw-smoke-"));
mkdirSync(work, { recursive: true });

const results = [];
let failed = false;
const step = (name) => console.log(`\n=== ${name}`);
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed = true;
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(cmd, cmdArgs, o = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 << 20, ...o });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}
function ps(script) {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
}
const psq = (s) => `'${s.replaceAll("'", "''")}'`;

function walk(d, pred, out = []) {
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (pred(p, e)) out.push(p);
    if (e.isDirectory()) walk(p, pred, out);
  }
  return out;
}
async function waitFor(fn, ms = 60000, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(every);
  }
  return !!(await fn());
}

const assets = readdirSync(dir);
const find = (re) => assets.find((a) => re.test(a));

// ---------------------------------------------------------------- checksums and asset set
step("Assets and checksums");
const sums = find(/^SHA256SUMS\.txt$/);
if (check("SHA256SUMS.txt present", !!sums)) {
  const lines = readFileSync(join(dir, sums), "utf8").split(/\r?\n/).filter(Boolean);
  const listed = new Set();
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) {
      check(`checksum line parses: ${line}`, false);
      continue;
    }
    listed.add(m[2]);
    const f = join(dir, m[2]);
    if (!existsSync(f)) {
      check(`listed asset exists: ${m[2]}`, false);
      continue;
    }
    check(`sha256 ${m[2]}`, createHash("sha256").update(readFileSync(f)).digest("hex") === m[1]);
  }
  for (const a of assets) if (a !== sums && !listed.has(a)) check(`asset covered by SHA256SUMS: ${a}`, false);
}
for (const a of assets) console.log(`  ${a}  ${(statSync(join(dir, a)).size / 1048576).toFixed(2)} MB`);
check("LGPL source tarball present", !!find(/^third-party-sources-.*\.tar\.gz$/));

const stage = join(work, "cli");
mkdirSync(stage, { recursive: true });

// ---------------------------------------------------------------- CLI (shared)
async function cliSmoke(cliPath) {
  step("CLI");
  const v = run(cliPath, ["--version"]);
  check("photoway --version equals tag", v.out.trim() === `photoway ${version}`, v.out.trim());
  const inputs = join(work, "inputs");
  const g = run(process.execPath, [join(root, "scripts", "gen-e2e-inputs.mjs"), inputs]);
  check("generate e2e inputs", g.code === 0, g.out.trim());
  const outs = join(work, "outs");
  mkdirSync(outs, { recursive: true });
  const ins = run(cliPath, ["inspect", "--json", inputs]);
  let entries = -1;
  try {
    entries = JSON.parse(ins.stdout).entries.length;
  } catch {}
  check("photoway inspect finds 12 geotagged photos", ins.code === 0 && entries === 12, `entries=${entries}`);
  const html = join(outs, "map.html");
  const folder = join(outs, "bundle");
  const zip = join(outs, "bundle.zip");
  for (const [fmt, out] of [["html", html], ["dir", folder], ["zip", zip]]) {
    const b = run(cliPath, ["build", inputs, "--out", out, "--format", fmt, "--full", "none"]);
    check(`photoway build --format ${fmt}`, b.code === 0, b.code === 0 ? "" : b.out.slice(-400));
  }
  check("html output is a non-trivial file", existsSync(html) && statSync(html).size > 500000);
  check("dir output has index.html", existsSync(join(folder, "index.html")));
  check("zip output is a zip", existsSync(zip) && readFileSync(zip).subarray(0, 2).toString() === "PK");
  // serve the folder on a free port and fetch the index
  const child = spawn(cliPath, ["serve", folder, "--addr", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "pipe"] });
  let first = "";
  child.stdout.on("data", (d) => (first += d));
  const gotLine = await waitFor(() => /Serving .* at (http:[^\s]+)/.test(first), 15000, 200);
  const url = /Serving .* at (http:[^\s]+)/.exec(first)?.[1];
  let status = 0;
  let body = "";
  if (gotLine) {
    try {
      const r = await fetch(url);
      status = r.status;
      body = await r.text();
    } catch (e) {
      body = String(e);
    }
  }
  child.kill();
  check("photoway serve answers with the index", gotLine && status === 200 && /<html|<!doctype/i.test(body), `${url} -> ${status}`);
}

// ---------------------------------------------------------------- launch helper
/** Starts the app binary, expects it to stay alive for ~10 s (and, on Windows, to own a window), then kills it. */
async function launchAndHold(exe, label) {
  const child = spawn(exe, [], { stdio: "ignore", detached: false });
  let exited = null;
  child.on("exit", (c, s) => (exited = `code=${c} signal=${s}`));
  await sleep(10000);
  let windowOk = true;
  let detail = exited ? `exited early (${exited})` : "alive after 10 s";
  if (!exited && win) {
    const r = ps(`(Get-Process -Id ${child.pid}).MainWindowHandle.ToInt64()`);
    const h = Number(r.stdout.trim());
    windowOk = h > 0;
    detail += `, MainWindowHandle=${h}`;
  }
  check(`${label} stays running with a window`, !exited && windowOk, detail);
  if (!exited) {
    if (win) run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
  }
  await sleep(1000);
}

// ---------------------------------------------------------------- Windows
async function windowsSmoke() {
  const nsis = find(/-setup\.exe$/);
  const msi = find(/\.msi$/);
  const cliZip = find(/^photoway-cli-.*-windows-x64\.zip$/);
  check("NSIS installer present", !!nsis);
  check("MSI present", !!msi);
  check("CLI zip present", !!cliZip);
  if (cliZip) {
    run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${psq(join(dir, cliZip))} -DestinationPath ${psq(stage)} -Force`]);
    check("CLI zip contains photoway.exe, LICENSE, notices", ["photoway.exe", "LICENSE", "THIRD_PARTY_NOTICES.md"].every((f) => existsSync(join(stage, f))));
  }

  const local = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const startMenus = [join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"), join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs")];
  const uninstallKeys = ["HKCU:", "HKLM:"].flatMap((h) =>
    [["Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall"], ["Software", "WOW6432Node", "Microsoft", "Windows", "CurrentVersion", "Uninstall"]].map((p) => [h, ...p].join(BS)),
  );
  const uninstallEntries = () => {
    const r = ps(
      `Get-ChildItem ${uninstallKeys.map(psq).join(",")} -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -like 'Photo Way*') { $_.PSPath } }`,
    );
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  };
  const extensionKeys = () => {
    const r = ps(
      `Get-ChildItem ${psq(["HKCU:", "Software", "Classes"].join(BS))},${psq(["HKLM:", "Software", "Classes"].join(BS))} -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName } | Where-Object { $_ -like '.*' }`,
    );
    return new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  };
  const shortcuts = () => startMenus.flatMap((d) => walk(d, (p) => /Photo Way.*\.lnk$/i.test(p)));
  check("no Photo Way install present before the test", uninstallEntries().length === 0, uninstallEntries().join(", "));
  const extBefore = extensionKeys();

  const installs = [
    { name: "NSIS", file: nsis, root: join(local, "Photo Way"), install: (f) => run(f, ["/S"]), uninstall: () => run(join(local, "Photo Way", "uninstall.exe"), ["/S"]) },
    {
      name: "MSI",
      file: msi,
      root: join(programFiles, "Photo Way"),
      install: (f) => run("msiexec", ["/i", f, "/qn", "/norestart", "/l*v", join(work, "msi-install.log")]),
      uninstall: (f) => run("msiexec", ["/x", f, "/qn", "/norestart", "/l*v", join(work, "msi-uninstall.log")]),
    },
  ];

  for (const t of installs) {
    if (!t.file) continue;
    step(`Windows ${t.name}`);
    const file = join(dir, t.file);
    const r = t.install(file);
    check(`${t.name} silent install exits 0`, r.code === 0, `exit ${r.code}`);
    // Where the installer actually put the app: the Start Menu shortcut's target, else the expected folder.
    const lnk = shortcuts()[0];
    const target = lnk ? ps(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)}).TargetPath`).stdout.trim() : "";
    if (target && existsSync(target) && dirname(target).toLowerCase() !== t.root.toLowerCase()) {
      console.log(`  note: ${t.name} shortcut target ${target} is outside the expected ${t.root}`);
      t.root = dirname(target);
    }
    const exes = walk(t.root, (p) => /photoway-app\.exe$/i.test(p)).concat(walk(t.root, (p) => /Photo Way\.exe$/i.test(p)));
    const exe = exes[0];
    console.log(`  install tree: ${walk(t.root, (p, e) => !e.isDirectory()).join(", ")}`);
    check(`${t.name}: app exe installed under ${t.root}`, !!exe, exe || "not found");
    check(`${t.name}: Start Menu shortcut exists`, shortcuts().length > 0, shortcuts().join(", "));
    const ent = uninstallEntries();
    check(`${t.name}: uninstall registry entry exists`, ent.length === 1, ent.join(", "));
    check(`${t.name}: notices bundled`, walk(t.root, (p) => /THIRD_PARTY_NOTICES/i.test(p)).length > 0);
    if (exe) {
      const vi = ps(`$v = (Get-Item ${psq(exe)}).VersionInfo; "$($v.FileVersion)|$($v.ProductVersion)|$($v.ProductName)|$($v.CompanyName)"`).stdout.trim();
      const [fv, pv, pn, cn] = vi.split("|");
      check(`${t.name}: exe file/product version equals ${version}`, fv?.startsWith(version) && pv?.startsWith(version), vi);
      check(`${t.name}: product name is Photo Way`, pn === "Photo Way", pn);
      await launchAndHold(exe, `${t.name} app`);
    }
    const added = [...extensionKeys()].filter((k) => !extBefore.has(k));
    check(`${t.name}: no file associations registered`, added.length === 0, added.join(", "));
    if (t.name === "NSIS" && exe) await cliSmokeOnce(join(stage, "photoway.exe"));

    const u = t.uninstall(file);
    check(`${t.name} silent uninstall exits 0`, u.code === 0, `exit ${u.code}`);
    const gone = await waitFor(() => !existsSync(t.root) || walk(t.root, (p) => /\.(exe|dll)$/i.test(p)).length === 0, 90000, 2000);
    check(`${t.name}: installed files removed`, gone, existsSync(t.root) ? walk(t.root, () => true).join(", ").slice(0, 300) : "");
    check(`${t.name}: uninstall registry entry removed`, await waitFor(() => uninstallEntries().length === 0, 30000, 2000), uninstallEntries().join(", "));
    check(`${t.name}: Start Menu shortcut removed`, shortcuts().length === 0, shortcuts().join(", "));
  }
}
let cliDone = false;
async function cliSmokeOnce(p) {
  if (cliDone || !existsSync(p)) return;
  cliDone = true;
  await cliSmoke(p);
}

// ---------------------------------------------------------------- macOS
async function macSmoke() {
  const dmg = find(/\.dmg$/);
  const cliTar = find(/^photoway-cli-.*-macos-universal\.tar\.gz$/);
  check("dmg present", !!dmg);
  check("CLI tarball present", !!cliTar);
  const arch = run("uname", ["-m"]).stdout.trim();
  console.log(`host arch: ${arch}`);
  const archs = (f) => run("lipo", ["-archs", f]).stdout.trim().split(/\s+/).sort().join(" ");

  if (cliTar) {
    const r = run("tar", ["-xzf", join(dir, cliTar), "-C", stage]);
    check("CLI tarball extracts", r.code === 0, r.out.trim());
    const cli = join(stage, "photoway");
    check("CLI is universal (arm64 + x86_64)", archs(cli) === "arm64 x86_64", archs(cli));
    const sig = run("codesign", ["--verify", "--strict", cli]);
    check("CLI signature verifies", sig.code === 0, sig.out.trim());
    check("CLI tarball contains LICENSE and notices", ["LICENSE", "THIRD_PARTY_NOTICES.md"].every((f) => existsSync(join(stage, f))));
  }

  if (dmg) {
    step("macOS dmg");
    const mnt = join(work, "mnt");
    const apps = join(work, "Applications");
    mkdirSync(mnt, { recursive: true });
    mkdirSync(apps, { recursive: true });
    const at = run("hdiutil", ["attach", join(dir, dmg), "-nobrowse", "-readonly", "-mountpoint", mnt]);
    check("dmg mounts", at.code === 0, at.out.trim().slice(-300));
    try {
      const app = walk(mnt, (p, e) => e.isDirectory() && p.endsWith(".app"))[0];
      if (check("dmg contains an .app", !!app, app || readdirSync(mnt).join(", "))) {
        check("dmg has an Applications link", existsSync(join(mnt, "Applications")));
        const dest = join(apps, "Photo Way.app");
        const cp = run("cp", ["-R", app, dest]);
        check("copy .app to a temp Applications folder", cp.code === 0, cp.out.trim());
        const plist = join(dest, "Contents", "Info.plist");
        const key = (k) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, plist]);
        const short = key("CFBundleShortVersionString").stdout.trim();
        const bundleV = key("CFBundleVersion").stdout.trim();
        check("CFBundleShortVersionString equals tag version", short === version, `${short} (CFBundleVersion ${bundleV})`);
        check("no CFBundleDocumentTypes (no file associations)", key("CFBundleDocumentTypes").code !== 0);
        const exeName = key("CFBundleExecutable").stdout.trim();
        const bin = join(dest, "Contents", "MacOS", exeName);
        check("app binary exists", existsSync(bin), bin);
        check("app binary is universal (arm64 + x86_64)", archs(bin) === "arm64 x86_64", archs(bin));
        const cs = run("codesign", ["-dv", "--verbose=2", dest]);
        check("codesign -dv reports a signature", cs.code === 0 && /Signature=|Authority=|flags=/.test(cs.out), cs.out.split("\n").filter((l) => /Signature|Authority|flags|Identifier/.test(l)).join("; "));
        const cv = run("codesign", ["--verify", "--deep", "--strict", dest]);
        check("codesign --verify --deep --strict passes", cv.code === 0, cv.out.trim());
        check("notices bundled in Resources", walk(join(dest, "Contents", "Resources"), (p) => /THIRD_PARTY_NOTICES/i.test(p)).length > 0);
        await launchAndHold(bin, "macOS app");
        await cliSmokeOnce(join(stage, "photoway"));
      }
    } finally {
      const d = run("hdiutil", ["detach", mnt, "-force"]);
      check("dmg detaches", d.code === 0, d.out.trim());
    }
  }
}

if (win) await windowsSmoke();
else if (mac) await macSmoke();
else {
  console.error(`unsupported platform ${process.platform}`);
  process.exit(2);
}
if (!cliDone) {
  const p = join(stage, win ? "photoway.exe" : "photoway");
  if (existsSync(p)) await cliSmokeOnce(p);
  else check("CLI available for the smoke run", false);
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name} ${r.detail}`);
if (!opt("work")) rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
