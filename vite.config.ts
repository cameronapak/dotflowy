import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

// SPA mode: no SSR. This sidesteps localStorage-on-server entirely,
// which matters because TanStack DB's localStorage collection reads
// globalThis.localStorage. With SPA mode there's no server render pass
// for routes, so the collection is only ever touched in the browser.
//
// It also keeps deployment trivial: any static CDN works.
export default defineConfig({
  server: {
    port: 3000,
    // Dev only: proxy the data API to a locally-running Worker + D1
    // (`bun run dev:api` -> wrangler dev on :8787). This keeps Vite HMR for the
    // UI while the real /api/nodes path is served by the Worker against a local
    // D1. In production the same Worker serves both. See docs/DECISIONS.md (D1 sync).
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  plugins: [
    tanstackStart({
      spa: { enabled: true },
    }),
    // Order matters: react's plugin must come after Start's.
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
