import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// E2E config. Chromium-only and headless by default so the suite stays snappy
// -- these are behavioral tests (caret/visual-line navigation needs a real
// browser layout engine), not cross-browser checks. Add more projects only if
// a bug turns out to be engine-specific.
// `E2E_PORT` exists for the one case a fixed port can't serve: two agent
// worktrees running the suite at once. Give the second one its own port.
const PORT = Number(process.env.E2E_PORT ?? 3210);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const VITE = fileURLToPath(
  new URL("./node_modules/vite/bin/vite.js", import.meta.url),
);

export default defineConfig({
  testDir: "./e2e",
  // These specs run against a real Worker under their own configs
  // (e2e/capture.config.ts, e2e/retirement.config.ts), not this Vite server.
  testIgnore: ["capture-real.spec.ts", "lunora-retirement-real.spec.ts"],
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
    // Use the installed entry point: Bun's nested script launch can lose .bin
    // from PATH in an orb. Keep Vite in dev mode for the deferred-resolve hooks.
    command: `"${process.execPath}" "${VITE}" dev --port ${PORT} --strictPort`,
    cwd: ROOT,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
