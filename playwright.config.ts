import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Chromium and headless by default. These are behavioral tests (caret/visual-line
// navigation needs a real layout engine). Engine-specific regressions can override
// browserName: typing-suggestions-webkit covers touch suggestion selection.
// `E2E_PORT` exists for the one case a fixed port can't serve: two agent
// worktrees running the suite at once. Give the second one its own port.
const PORT = Number(process.env.E2E_PORT ?? 3210);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const VITE = fileURLToPath(
  new URL("./node_modules/vite/bin/vite.js", import.meta.url),
);

export default defineConfig({
  testDir: "./e2e",
  // Real Worker suites own their backend rather than using this Vite server.
  testIgnore: ["lunora-retirement-real.spec.ts", "worker-browser/**"],
  fullyParallel: true,
  // Each worker owns a browser in addition to the shared Vite server. Leave
  // room for the agent and other checks on a medium Orb (4 CPUs, 8 GB RAM).
  // Larger machines can opt in to more parallelism with --workers=N.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "day-stream-webkit",
      testMatch: "day-stream.spec.ts",
      grep: /day navigation on touch/,
      use: { ...devices["iPhone 13"] },
    },
  ],
  // Always boot our own Vite server, NEVER adopt one already on the port.
  // `dev`/`dev:web` serve :3000, so the only thing that ever answers on this
  // port is another Playwright run -- a zombie from an aborted suite, or a
  // sibling worktree serving DIFFERENT source. Reusing either runs the tests
  // against code that isn't in front of you, and the failures are shaped
  // exactly like real regressions. Playwright throws on a busy port instead,
  // which is the loud version of the same fact.
  webServer: {
    // Use the installed entry point: Bun's nested script launch can lose .bin
    // from PATH in an orb.
    command: `"${process.execPath}" "${VITE}" dev --port ${PORT} --strictPort`,
    cwd: ROOT,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
