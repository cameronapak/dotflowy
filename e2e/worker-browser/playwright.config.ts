import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "workflow.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  outputDir: "../../test-results/worker-browser",
  reporter: "list",
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "America/Chicago",
    colorScheme: "light",
    trace: "retain-on-failure",
  },
});
