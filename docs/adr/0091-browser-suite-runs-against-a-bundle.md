---
status: accepted
---

# Run the app browser suite against a development-mode bundle

`bun run test:e2e:app` builds the app once and serves the bundle. It no longer
drives the Vite development server. `E2E_SERVER=dev` keeps the development
server for a spec you are iterating on.

## Why

An audit of 150 workflow runs (November 13 to 15, 2026) put 80% of all CI time
in running steps, and the app browser shards were nearly all of it. The median
app test took 5.1 seconds. Most of that was not the test. Every test loads the
app again, and the development server answers each source module as its own
request.

On the same machine, the same 104 tests across eight spec files ran in about
220 seconds against the bundle. Their CI medians against the development
server sum to about 680 seconds.

## What the bundle keeps

- **Development mode.** `scripts/e2e-bundle.ts` builds with
  `NODE_ENV=development` and `--mode development`, so `import.meta.env.DEV` is
  true. The structural-write tripwire, the history and mirror guards, and
  `window.__hotkeyManager` are all present. Three specs assert that the
  tripwire stays silent; in a production-mode bundle they would pass without
  checking anything.
- **Module URLs.** Specs read live app state by importing a source module
  inside the page, such as `import("/src/data/history.ts")`. A bundle has no
  such URL. A plugin in `vite.config.ts` scans `e2e/*.ts` for `"/src/…"`
  strings and emits each module as a chunk at that path. The chunk re-exports
  from the app's own chunks, so a spec sees the instances the app uses.
- **Every spec and assertion.** No test was removed, skipped, or given a wider
  timeout.

## What changed in specs

- Four tests recorded a row position while the outline's 260 ms entrance
  (`.outline-reveal`, a fade and a 4px rise) was still running, then compared
  later positions against it. The development server was slow enough to hide
  that. They now call `outlineRevealed(page)` before they record geometry.
- `bootstrap-readiness.spec.ts` holds the lazy editor's request. That request
  is `/src/components/OutlineEditor.tsx` on the development server and
  `/assets/OutlineEditor-<hash>.js` in the bundle. It matches both.
- The touch swipe in `drag-reorder.spec.ts` sent its moves with no timestamps,
  so their arrival times set the swipe's speed. When they arrived in a burst,
  Chromium read a flick, and the fling scrolled the tapped row out of the
  window. It failed once in a full run against the bundle. The swipe now states
  its timestamps, as the sheet swipe in `mobile-drawers.spec.ts` already did.

## What the suite no longer covers

The suite does not exercise the Vite development server: per-module loading,
dependency pre-bundling, or hot reload. No spec asserted any of them.

Neither the old suite nor this one tests the production-mode bundle that
deploys. That gap is unchanged.

## Don't

- Don't build the suite's bundle into `dist/`. That directory deploys, and a
  development-mode bundle there could ship. The bundle lives in
  `node_modules/.cache/e2e-bundle`.
- Don't pass `--outDir` to the build. TanStack Start prerenders the shell from
  the server build it finds through config. With a CLI flag it reads `dist/`
  and writes a shell that names another build's assets.
- Don't switch the bundle to production mode without first moving the
  development-only assertions somewhere that still runs them.
- Don't read geometry for a later comparison before `outlineRevealed`.

The module-URL plugin marks its chunks as non-entry in `generateBundle`,
because TanStack Start's manifest accepts one client entry. If Start changes
that check, the build fails; it cannot silently drop a module.
