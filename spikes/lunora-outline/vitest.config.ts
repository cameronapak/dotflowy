import { defineConfig } from "vitest/config";

// Pure planner tests — do NOT load vite.config.ts (lunora/Cloudflare plugin).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
