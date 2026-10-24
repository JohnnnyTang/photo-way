import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { viewport: { width: 1280, height: 800 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      // CI runners without a GPU: ask Firefox for software WebGL (the map needs WebGL 2).
      use: { ...devices["Desktop Firefox"], launchOptions: { firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.enable-webgl2": true, "webgl.disable-fail-if-major-performance-caveat": true } } },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
