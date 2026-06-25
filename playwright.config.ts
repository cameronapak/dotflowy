import { defineConfig, devices } from "@playwright/test";

// E2E config. Chromium-only and headless by default so the suite stays snappy
// -- these are behavioral tests (caret/visual-line navigation needs a real
// browser layout engine), not cross-browser checks. Add more projects only if
// a bug turns out to be engine-specific.
const PORT = 3000;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  // Boot the Wasp dev server (client :3000, server :3001). Reuse a running
  // `wasp start` locally so an open session makes the suite start instantly.
  webServer: {
    command: "wasp start",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
