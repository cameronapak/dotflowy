import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const spikeRoot = path.dirname(fileURLToPath(import.meta.url));
const outlinePlans = path.resolve(spikeRoot, "../../src/data/outline-plans");

// Pure planner / bridge tests — do NOT load vite.config.ts (lunora/Cloudflare plugin).
export default defineConfig({
  resolve: {
    alias: {
      "@dotflowy/outline-plans": outlinePlans,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
