import { defineConfig, devices } from "@playwright/test";

// E2E config. Chromium-only and headless by default so the suite stays snappy
// -- these are behavioral tests (caret/visual-line navigation needs a real
// browser layout engine), not cross-browser checks. Add more projects only if
// a bug turns out to be engine-specific.
// `E2E_PORT` exists for the one case a fixed port can't serve: two agent
// worktrees running the suite at once. Give the second one its own port.
const PORT = Number(process.env.E2E_PORT ?? 3210);

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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Always boot our own Vite server, NEVER adopt one already on the port.
  // `dev`/`dev:web` serve :3000, so the only thing that ever answers on this
  // port is another Playwright run -- a zombie from an aborted suite, or a
  // sibling worktree serving DIFFERENT source. Reusing either runs the tests
  // against code that isn't in front of you, and the failures are shaped
  // exactly like real regressions. Playwright throws on a busy port instead,
  // which is the loud version of the same fact.
  webServer: {
    command: `bun run dev:web --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
