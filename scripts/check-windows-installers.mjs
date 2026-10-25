// Assert a release contains one NSIS setup and, from v0.2.0, both localized MSI variants.
// Usage: node scripts/check-windows-installers.mjs <release-assets-directory> <version>
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const directory = process.argv[2];
const version = process.argv[3];
if (!directory || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/check-windows-installers.mjs <release-assets-directory> <version>");
  process.exit(2);
}

const names = readdirSync(resolve(directory));
const nsis = names.filter((name) => name.endsWith("-setup.exe"));
const msi = names.filter((name) => name.endsWith(".msi"));
const matchesLocale = (name, locale) => new RegExp(`(?:_|-)${locale}\\.msi$`, "i").test(name);
const [major, minor] = version.split(".").map(Number);
const bilingual = major > 0 || minor >= 2;

if (nsis.length !== 1 || (bilingual ? msi.length !== 2 : ![1, 2].includes(msi.length)) ||
    !msi.some((name) => matchesLocale(name, "en-US")) ||
    (msi.length === 2 && !msi.some((name) => matchesLocale(name, "zh-CN")))) {
  console.error(`Expected one NSIS setup and ${bilingual ? "en-US/zh-CN MSI files" : "at least an en-US MSI file"}; found: ${names.join(", ")}`);
  process.exit(1);
}
console.log(`Windows installers: ${nsis[0]}, ${msi.join(", ")}`);
