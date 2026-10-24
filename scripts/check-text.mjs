// Fails if tracked text files contain raw U+2028/U+2029 (they break inline <script> JSON and
// have slipped into docs before). Usage: node scripts/check-text.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Built from code points so this file never contains the characters (or escapes that tools may expand).
const separators = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`);
const textExt = /\.(md|json|ts|js|mjs|rs|toml|yml|yaml|html|css|sh|ps1|txt)$/i;

const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter((f) => textExt.test(f));
const bad = [];
for (const f of files) {
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (separators.test(line)) bad.push(`${f}:${i + 1}`);
    });
}
if (bad.length) {
  console.error(`Raw U+2028/U+2029 found (write them as escapes):\n${bad.join("\n")}`);
  process.exit(1);
}
console.log(`check-text: ${files.length} text files OK`);
