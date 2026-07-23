import { lunora } from "@lunora/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const spikeRoot = path.dirname(fileURLToPath(import.meta.url));
const outlinePlans = path.resolve(spikeRoot, "../../src/data/outline-plans");

// https://vite.dev/config/
export default defineConfig({
  plugins: [lunora(), react()],
  resolve: {
    alias: {
      // Shared planners live in the Dotflowy repo root (bun). Spike (pnpm)
      // imports them via this alias — see HANDOFF + spike README.
      "@dotflowy/outline-plans": outlinePlans,
    },
  },
});
