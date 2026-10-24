// Prints the CHANGELOG.md section for a version (Keep a Changelog format) to stdout.
//   node scripts/changelog-notes.mjs v0.2.0     -> body of "## [0.2.0] - date"
// Falls back to "## [Unreleased]" (with a note) when the version has no section yet, so dry runs still work.
import { readFileSync } from "node:fs";

const want = (process.argv[2] ?? "").replace(/^v/, "");
const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const heading = /^## \[([^\]]+)\]/;

function section(name) {
  const start = lines.findIndex((l) => heading.exec(l)?.[1].toLowerCase() === name.toLowerCase());
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

const body = want ? section(want) : null;
if (body) {
  console.log(body);
} else {
  const unreleased = section("Unreleased");
  console.log(`_No changelog section for ${want || "this build"}; showing Unreleased._\n\n${unreleased ?? ""}`.trim());
}
