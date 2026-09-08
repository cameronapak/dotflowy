---
status: accepted
---

# Verification runs where it ships

**What.** The verification path runs the app the way users get it, and any
agent can drive it from a fresh clone with one command, `bun run verify`
(#349). Three moves:

1. **Worker tests execute inside real workerd** via
   `@cloudflare/vitest-plugin` (the renamed successor of
   `@cloudflare/vitest-pool-workers`) - the same runtime, D1, and Durable
   Objects the deploy serves. `src/` pure-logic tests run in a plain node
   pool. One runner (Vitest), one command (`bun run test`).
2. **E2e is prod-parity and self-booted.** Playwright's `webServer` builds
   the SPA once, then boots `wrangler dev` serving SPA + API from a single
   origin - no Vite dev server, no proxy, no wrangler somebody forgot to
   start. `globalSetup` signs up a unique-per-run user through the real
   HTTP signup (invite-gated by default, open signup honored when
   SIGNUP_OPEN is on), so reruns never couple to stale local state.
3. **CI runs the same bar.** The quality job calls `bun run verify:quick`
   (everything except e2e, ~2 min feedback) and a sharded `e2e` job runs
   the full Playwright suite in parallel over the identical stack - two
   jobs, one bar. Splitting keeps wall time near the fast job's; deleting
   e2e from CI was considered and rejected (interrogate review): the editor
   has no other CI coverage, nothing would attest a local e2e run, and the
   build itself is only proven inside the e2e boot. No device in the loop
   anywhere.

**Why not the Vite dev server + proxy.** E2e used to run against `vite dev`
proxying `/api` to a wrangler that nothing started - not headless, not
prod-shaped, and the proxy already bit once (the ADR 0058 dogfood hang:
Vite's string proxy shorthand skips the WebSocket upgrade listener, so
`/api/sync` and `/_lunora/ws` silently never reached the Worker). Testing
the built SPA on workerd deletes the proxy, the manual wrangler, and the
two-origins-never-quite-like-prod drift in one move.

**Why Bun stays.** Bun is the package manager and script runner only; the
shipped app has zero Bun dependencies, and Bun installs headlessly
anywhere wrangler does. Swapping it would burn the lockfile, CI, and the
worktree bootstrap for no Cloudflare gain. Cloudflare-native was never
about the package manager - it is about tests running where the code
ships.

**Consequences.**

- Dev loops are unchanged: `cf:dev` and the HMR loop keep their shape.
  This ADR is about the verification path, not the dev path.
- Test migration is mechanical (bun:test imports to vitest); existing
  mocks stay mocks. Runtime fidelity comes from the pool, not from
  rewriting fixtures.
- E2e state is disposable by design: teardown kills only what the run
  started, and evidence survives it.
- E2e-only seams are build-flagged, never DEV-flagged: `import.meta.env.DEV`
  is false in every `vite build`, so a DEV gate silently compiles the seam
  out of the exact bundle the specs need. `VITE_QUICK_ADD_DEFERRED_SEAM=1`
  (set by scripts/e2e-serve.ts) keeps the quick-add deferred-resolve gate
  compiled in; ordinary builds tree-shake it to zero bytes (verified both
  ways). The pattern to steal: `isXOn(env.VITE_FLAG)` type-guard +
  mount-effect install, never a module-scope DEV check.
