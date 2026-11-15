import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { readdirSync, readFileSync } from "node:fs";
import { defineConfig, type BuildEnvironmentOptions, type Plugin } from "vite";

import pkg from "./package.json";
import { changelogPlugin } from "./scripts/vite-plugin-changelog";

// Upload client source maps to Sentry (#227), build-time only. Gated on the
// build secret so a normal `bun run build` (no token — local, CI, a fork) stays
// clean: no map emission, no upload. `filesToDeleteAfterUpload` is REQUIRED for
// the plugin to delete the maps post-upload — without it (we enable
// build.sourcemap ourselves, so the plugin won't infer it) the .map files ship
// to the public CDN and expose original source.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

// The app browser suite runs against a bundle (`scripts/e2e-bundle.ts`), not
// the development server. Its specs read live app state by importing a source
// module by URL inside the page, such as `import("/src/data/history.ts")`. The
// development server answers that URL with the module the app already loaded.
// A bundle has no such URL, so this build emits each module the specs name as
// a chunk at that exact path. The chunk shares the app's module instances.
const E2E_DIR = new URL("./e2e/", import.meta.url);
function e2eModuleUrls(): Plugin {
  const paths = new Set<string>();
  for (const name of readdirSync(E2E_DIR)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(new URL(name, E2E_DIR), "utf8");
    for (const match of source.matchAll(/"(\/src\/[^"]+\.tsx?)"/g)) {
      if (match[1]) paths.add(match[1]);
    }
  }
  return {
    name: "dotflowy:e2e-module-urls",
    applyToEnvironment: (environment) => environment.name === "client",
    enforce: "pre",
    buildStart() {
      for (const path of paths) {
        this.emitFile({
          type: "chunk",
          id: new URL(`.${path}`, import.meta.url).pathname,
          fileName: path.slice(1),
          preserveSignature: "exports-only",
        });
      }
    },
    // TanStack Start builds its manifest from the one client entry and rejects
    // a second. These chunks are loaded by specs, never by the document.
    generateBundle(_options, bundle) {
      for (const path of paths) {
        const chunk = bundle[path.slice(1)];
        if (chunk?.type === "chunk") chunk.isEntry = false;
      }
    },
  };
}
// `scripts/e2e-bundle.ts` sets this to the directory it serves. The directory
// comes from config, not `--outDir`: TanStack Start prerenders the shell from
// the server build it finds through this config, and a CLI flag does not reach it.
const e2eBundleDir = process.env.DOTFLOWY_E2E_BUNDLE;
// Emit source maps only when we're going to upload + delete them (below), so
// they never ship to the CDN on a tokenless build.
const build: BuildEnvironmentOptions = {};
if (sentryAuthToken) build.sourcemap = true;
if (e2eBundleDir) build.outDir = e2eBundleDir;

// SPA mode: no SSR. This sidesteps localStorage-on-server entirely,
// which matters because TanStack DB's localStorage collection reads
// globalThis.localStorage. With SPA mode there's no server render pass
// for routes, so the collection is only ever touched in the browser.
//
// It also keeps deployment trivial: any static CDN works.
export default defineConfig({
  build,
  // cf:dev crosses high-latency portals: one client bundle avoids many waves
  // of chunk requests. Keep production and the Vite HMR loop unchanged.
  environments:
    process.env.DOTFLOWY_CF_DEV === "true"
      ? {
          client: {
            build: {
              rolldownOptions: { output: { codeSplitting: false } },
            },
          },
        }
      : undefined,
  server: {
    port: 3000,
    // Amp orb portals proxy the dev server through *.onamp.dev.
    allowedHosts: [".onamp.dev"],
    // Dev only: proxy the data API to a locally-running Worker + D1
    // (`bun run dev:api` -> wrangler dev on :8787). This keeps Vite HMR for the
    // UI while the real /api/nodes path is served by the Worker against a local
    // D1. In production the same Worker serves both. See docs/adr/0008-sync-via-a-per-user-durable-object.md.
    // `ws: true` is required — Vite's string shorthand only sets
    // `{ target, changeOrigin }` and skips the upgrade listener, so
    // `/api/sync` never reaches wrangler (outline stuck on "Loading outline").
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        ws: true,
      },
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
    ...(e2eBundleDir ? [e2eModuleUrls()] : []),
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
