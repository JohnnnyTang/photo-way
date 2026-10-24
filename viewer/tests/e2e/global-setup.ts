// Builds the three outputs once per `playwright test` run (CLI when usable, reference layouts otherwise).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export default async function globalSetup(): Promise<void> {
  const mod = await import(pathToFileURL(resolve(process.cwd(), "..", "scripts", "e2e-outputs.mjs")).href);
  await mod.prepareOutputs();
}
