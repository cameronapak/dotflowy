import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import pkg from "./package.json";
import { changelogPlugin } from "./scripts/vite-plugin-changelog";

// Upload client source maps to Sentry (#227), build-time only. Gated on the
// build secret so a normal `bun run build` (no token — local, CI, a fork) stays
// clean: no map emission, no upload. `filesToDeleteAfterUpload` is REQUIRED for
// the plugin to delete the maps post-upload — without it (we enable
// build.sourcemap ourselves, so the plugin won't infer it) the .map files ship
// to the public CDN and expose original source.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

// SPA mode: no SSR. This sidesteps localStorage-on-server entirely,
// which matters because TanStack DB's localStorage collection reads
// globalThis.localStorage. With SPA mode there's no server render pass
// for routes, so the collection is only ever touched in the browser.
//
// It also keeps deployment trivial: any static CDN works.
export default defineConfig({
  // Emit source maps only when we're going to upload + delete them (below), so
  // they never ship to the CDN on a tokenless build.
  build: sentryAuthToken ? { sourcemap: true } : {},
  server: {
    port: 3000,
    // Dev only: proxy the data API to a locally-running Worker + D1
    // (`bun run dev:api` -> wrangler dev on :8787). This keeps Vite HMR for the
    // UI while the real /api/nodes path is served by the Worker against a local
    // D1. In production the same Worker serves both. See docs/adr/0008-sync-via-a-per-user-durable-object.md.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  plugins: [
    // Fails the build when `changelog/<package.json version>/` is missing, and
    // serves the validated release array as `virtual:dotflowy-changelog`.
    changelogPlugin({
      dir: new URL("./changelog", import.meta.url).pathname,
      packageVersion: pkg.version,
    }),
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
    // Last: after the bundle + maps exist. No-op without SENTRY_AUTH_TOKEN.
    ...(sentryAuthToken
      ? [
          sentryVitePlugin({
            org: "cameron-pak-sole-trader",
            project: "dotflowy",
            authToken: sentryAuthToken,
            // Delete the emitted maps after upload so they never reach the CDN.
            sourcemaps: {
              filesToDeleteAfterUpload: ["./dist/client/**/*.map"],
            },
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
