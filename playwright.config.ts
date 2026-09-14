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
  // Prod parity, self-booted (ADR 0061): the webServer builds the SPA once,
  // applies local D1 migrations, then `wrangler dev` serves SPA + Worker +
  // DOs from ONE origin - the same shape as production. No Vite dev server,
  // no proxy (the ADR 0058 dogfood hang is the receipt on proxies), no
  // wrangler somebody forgot to start. global-setup.ts then signs up a
  // unique-per-run user through the real HTTP signup: the stack's doctor.
  globalSetup: "./e2e/global-setup.ts",
  // Always boot our own origin, NEVER adopt one already on the port - the
  // only thing that ever answers here is another Playwright run (a zombie
  // from an aborted suite, or a sibling worktree serving DIFFERENT source).
  // Reusing either runs the tests against code that isn't in front of you,
  // and the failures are shaped exactly like real regressions. Playwright
  // throws on a busy port instead, which is the loud version of the same
  // fact.
  webServer: {
    command: `bun scripts/e2e-serve.ts`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    // Build + migrations + wrangler boot: slower than a bare Vite dev server,
    // but this is the verification path, not the HMR loop.
    timeout: 300_000,
    // Stream server output so build/boot failures are visible in the report.
    stdout: "pipe",
  },
});
