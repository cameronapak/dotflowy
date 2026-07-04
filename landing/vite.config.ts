import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone marketing site for dotflowy.com. Unlike the app (which is SPA-only
// to dodge localStorage/collection access during SSR), the landing has no such
// constraint, so it's fully PRERENDERED to static HTML: the hero copy and <head>
// meta are baked into index.html for SEO + instant first paint, then it hydrates
// one interactive island (the hero outline demo). Output is pure static assets —
// no runtime server — served from Cloudflare on dotflowy.com.
export default defineConfig({
  server: { port: 3100 },
  plugins: [
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
      pages: [{ path: "/", prerender: { enabled: true } }],
    }),
    // Order matters: react's plugin must come after Start's.
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
