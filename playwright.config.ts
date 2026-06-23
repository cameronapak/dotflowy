import { defineConfig, devices } from "@playwright/test";

// E2E config. Chromium-only and headless by default so the suite stays snappy
// -- these are behavioral tests (caret/visual-line navigation needs a real
// browser layout engine), not cross-browser checks. Add more projects only if
// a bug turns out to be engine-specific.
const PORT = 3210;

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
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Boot the Vite dev server for the run; reuse one already running locally so
  // an open `bun run dev` makes the suite start instantly.
  webServer: {
    command: `bun run dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
