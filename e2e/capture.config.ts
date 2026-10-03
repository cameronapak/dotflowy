import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "capture-real.spec.ts",
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
});
