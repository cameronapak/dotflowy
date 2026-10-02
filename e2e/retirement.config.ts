import { defineConfig } from "@playwright/test";

// Storage-only Workerd tests do not need Vite or a browser server.
export default defineConfig({
  testDir: ".",
  testMatch: "lunora-retirement-real.spec.ts",
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
});
