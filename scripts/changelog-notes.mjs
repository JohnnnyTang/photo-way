// Print a release section from CHANGELOG.md. Tagged releases from v0.2.0
// onward require non-empty English and Simplified Chinese subsections.
import { readFileSync } from "node:fs";

const want = (process.argv[2] ?? "").replace(/^v/, "");
const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/);
const heading = /^## \[([^\]]+)\]/;

function section(name) {
  const start = lines.findIndex((l) => heading.exec(l)?.[1].toLowerCase() === name.toLowerCase());
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

function needsBilingualNotes(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match !== null && (Number(match[1]) > 0 || Number(match[2]) >= 2);
}

function validateBilingualNotes(body) {
  const subsections = [...body.matchAll(/^### (.+?)\s*$/gm)];
  if (subsections.length !== 2 || subsections[0][1] !== "English" || subsections[1][1] !== "简体中文") {
    return "expected one ### English section followed by one ### 简体中文 section";
  }
  for (let index = 0; index < subsections.length; index++) {
    const start = subsections[index].index + subsections[index][0].length;
    const end = subsections[index + 1]?.index ?? body.length;
    const content = body.slice(start, end).trim();
    if (!content || !/^[-*] \S/m.test(content)) {
      return `${subsections[index][1]} release notes need at least one non-empty bullet`;
    }
  }
  return null;
}

const body = want ? section(want) : null;
if (body) {
  if (process.argv.includes("--require") && needsBilingualNotes(want)) {
    const error = validateBilingualNotes(body);
    if (error) {
      console.error(`CHANGELOG.md ${want}: ${error}`);
      process.exit(1);
    }
  }
  console.log(body);
} else if (process.argv.includes("--require")) {
  console.error(`CHANGELOG.md has no non-empty section for ${want || "this version"}`);
  process.exit(1);
} else {
  const unreleased = section("Unreleased");
  console.log(`_No changelog section for ${want || "this build"}; showing Unreleased._\n\n${unreleased ?? ""}`.trim());
}
