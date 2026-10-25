// Assert a release contains one multilingual NSIS setup and both localized MSI variants.
// Usage: node scripts/check-windows-installers.mjs <release-assets-directory>
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const directory = process.argv[2];
if (!directory) {
  console.error("Usage: node scripts/check-windows-installers.mjs <release-assets-directory>");
  process.exit(2);
}

const names = readdirSync(resolve(directory));
const nsis = names.filter((name) => name.endsWith("-setup.exe"));
const msi = names.filter((name) => name.endsWith(".msi"));
const matchesLocale = (name, locale) => new RegExp(`(?:_|-)${locale}\\.msi$`, "i").test(name);

if (nsis.length !== 1 || msi.length !== 2 ||
    !msi.some((name) => matchesLocale(name, "en-US")) ||
    !msi.some((name) => matchesLocale(name, "zh-CN"))) {
  console.error(`Expected one NSIS setup and en-US/zh-CN MSI files; found: ${names.join(", ")}`);
  process.exit(1);
}
console.log(`Windows installers: ${nsis[0]}, ${msi.join(", ")}`);
