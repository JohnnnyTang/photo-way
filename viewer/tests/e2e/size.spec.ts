// Wave 2 · G: output size gate (docs/PLAN.md 2.1) on the outputs produced for this run.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, repoRoot, test } from "./helpers";

test("empty shell and fixture builds stay within the size budgets", async ({ manifest, browserName }) => {
  test.skip(browserName !== "chromium", "size does not depend on the engine");
  const ids = ["shell", "output-html", "output-dir", ...(manifest.source === "cli" ? ["output-zip"] : [])];
  const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "check-size.mjs"), "--only", ids.join(","), "--require"], { encoding: "utf8" });
  console.log(r.stdout);
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
