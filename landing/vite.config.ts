import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import rootPkg from "../package.json";
import { changelogPlugin } from "../scripts/vite-plugin-changelog";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const landingSrc = join(dirname(fileURLToPath(import.meta.url)), "src");

// Standalone marketing site for dotflowy.com. Unlike the app (which is SPA-only
// to dodge localStorage/collection access during SSR), the landing has no such
// constraint, so it's fully PRERENDERED to static HTML: the hero copy and <head>
// meta are baked into index.html for SEO + instant first paint, then it hydrates
// for the hero graphic's pointer parallax. Output is pure static assets —
// no runtime server — served from Cloudflare on dotflowy.com.
export default defineConfig({
  server: {
    port: 3100,
    // Amp orb portals proxy the dev server through *.onamp.dev.
    allowedHosts: [".onamp.dev"],
  },
  plugins: [
    // Same archive the in-app dialog uses (ADR 0046). packageVersion is the
    // ROOT app's version — landing's own package.json is unrelated.
    changelogPlugin({
      dir: join(rootDir, "changelog"),
      packageVersion: rootPkg.version,
    }),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
      pages: [
        { path: "/", prerender: { enabled: true } },
        { path: "/changelog", prerender: { enabled: true } },
        { path: "/mcp", prerender: { enabled: true } },
        { path: "/try", prerender: { enabled: true } },
      ],
    }),
    // Order matters: react's plugin must come after Start's.
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": landingSrc,
      // Shared inline-markdown parser — dependency-free (no Effect).
      "@dotflowy/changelog-markdown": join(
        rootDir,
        "src/data/changelog-markdown.ts",
      ),
    },
  },
});
