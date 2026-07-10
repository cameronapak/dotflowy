import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

// SPA mode: no SSR. This sidesteps localStorage-on-server entirely,
// which matters because TanStack DB's localStorage collection reads
// globalThis.localStorage. With SPA mode there's no server render pass
// for routes, so the collection is only ever touched in the browser.
//
// It also keeps deployment trivial: any static CDN works.
export default defineConfig({
  server: {
    // Bind IPv4 so `localhost` / `127.0.0.1` hit the same listener (Vite 8
    // otherwise may own only ::1 while the Worker proxy target is IPv4).
    host: "127.0.0.1",
    port: 3000,
    // Dev only: proxy the data API to a locally-running Worker + D1
    // (`bun run dev:api` -> wrangler dev on :8787). This keeps Vite HMR for the
    // UI while the real /api/nodes path is served by the Worker against a local
    // D1. In production the same Worker serves both. See docs/adr/0008-sync-via-a-per-user-durable-object.md.
    //
    // `ws: true` is required for `/api/sync` (the live outline WebSocket). The
    // string-form proxy target alone does not always upgrade WS through Vite 8,
    // which surfaces as "WebSocket is closed before the connection is established"
    // and bootstrap failing with "sync socket closed before initial data".
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  plugins: [
    tanstackStart({
      spa: { enabled: true },
    }),
    // Order matters: react's plugin must come after Start's.
    viteReact(),
    // React Compiler auto-memoizes components/hooks at build time, so the
    // editor's per-keystroke re-renders stay scoped without hand-written
    // memo/useMemo everywhere. React 19 ships the compiler runtime in-tree,
    // so no extra runtime package is needed. Health-checked: 137/137
    // components compile, no incompatible libraries.
    //
    // On Vite 8 / Rolldown, plugin-react uses the native Oxc transform (no
    // Babel), so the compiler runs through @rolldown/plugin-babel via the
    // reactCompilerPreset helper rather than a viteReact `babel` option.
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
