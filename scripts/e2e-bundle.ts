#!/usr/bin/env bun
/**
 * Builds and serves the bundle the app browser suite runs against (ADR 0091).
 *
 * The suite used to drive the Vite development server, which serves each
 * source module as its own request. Every test loads the app again, so most of
 * a test's time went to module loading, not to the test. A bundle loads in a
 * fraction of that time.
 *
 * The build keeps development mode: `import.meta.env.DEV` stays true, so the
 * structural-write tripwire and the other development-only checks still run.
 * It writes outside `dist/`, which holds the bundle that deploys.
 */
import { join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "node_modules/.cache/e2e-bundle");
const CLIENT = join(OUT, "client");
const VITE = join(ROOT, "node_modules/vite/bin/vite.js");
const port = Number(process.env.E2E_PORT ?? 3210);

const build = Bun.spawn(["node", VITE, "build", "--mode", "development"], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    NODE_ENV: "development",
    // `vite.config.ts` writes the bundle here and emits the source modules
    // that specs import by URL.
    DOTFLOWY_E2E_BUNDLE: OUT,
  },
});
const buildExit = await build.exited;
if (buildExit !== 0) process.exit(buildExit);

Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    // The development server proxies /api to a Worker on :8787 and answers 500
    // when none is listening. Specs mock the data API; keep the unmocked
    // answer the same.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return new Response("No Worker behind the app browser suite", {
        status: 500,
      });
    }
    const path = resolve(CLIENT, `.${decodeURIComponent(pathname)}`);
    if (path !== CLIENT && path.startsWith(CLIENT + sep)) {
      const file = Bun.file(path);
      if (await file.exists()) {
        // `vite.config.ts` emits the source modules that specs import by URL
        // under their source paths. They hold JavaScript whatever the extension.
        return pathname.startsWith("/src/")
          ? new Response(file, {
              headers: { "content-type": "text/javascript" },
            })
          : new Response(file);
      }
    }
    // Client routes such as `/<nodeId>` resolve through the SPA shell. A path
    // with an extension names a file, and a missing file is a 404.
    if (!/\.[a-z0-9]+$/i.test(pathname)) {
      return new Response(Bun.file(join(CLIENT, "_shell.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`App browser bundle on http://localhost:${port}`);
