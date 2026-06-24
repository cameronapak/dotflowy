# ADR 0023: Cloudflare D1 sync via a Worker (single-user, behind Access)

Status: accepted (2026-06-23), implemented (data path verified end-to-end locally).
Realizes the backend-swap path the README and [ADR 0004](./0004-spa-only-no-ssr.md)
always pointed at, but lands on **Cloudflare D1**, not the Postgres + ElectricSQL path
the README originally sketched.

## Glossary

- **D1** — Cloudflare's serverless SQLite. Reachable only from a Worker binding, never
  from the browser.
- **The Worker** — one Cloudflare Worker (`worker/index.ts`) that both serves the static
  SPA (via the `ASSETS` binding) and hosts the `/api/nodes` sync API against D1.
- **Owner** — the row-scoping key: the Cloudflare Access authenticated email. Every
  `nodes` row carries an `owner` column; every query is scoped to it.
- **Query collection** — TanStack DB's `queryCollectionOptions` adapter: a `queryFn`
  pulls full server state, mutation handlers write through to the API.

## Context

dotflowy was local-first: all nodes in `localStorage` via TanStack DB's
`localStorageCollection`, no server (ADR 0004). The goal here is multi-device sync for a
**single user (the author)**, hosted entirely on Cloudflare.

The hard fact that shapes everything: **the browser cannot talk to D1 directly** — D1 is
a Worker binding. So "use D1" is not a config swap; it requires a server tier. And a
server-backed store without identity would be one global outline every visitor shares.
For a personal tool we want *my* data on *my* devices, which needs identity.

## Decision

1. **One Worker serves the SPA and the API.** Static assets are served via the `ASSETS`
   binding; `run_worker_first: ["/api/*"]` routes only `/api/*` through the Worker. Every
   other path (including `/$nodeId` zoom routes) is served straight from assets with the
   SPA fallback to `index.html`. Keeps everything in one Cloudflare project, one deploy.

2. **Identity = Cloudflare Access, scoped by email.** The app sits behind Access
   (configured on the zone, not in code). Access authenticates at the edge and injects a
   verified `Cf-Access-Authenticated-User-Email` header; the Worker uses it as the `owner`
   and scopes every read/write (`WHERE owner = ?`). Near-zero auth code, maximally
   Cloudflare-native. Trade-off: Access gates the **whole** site — no anonymous "try it"
   visitors. Acceptable because this deployment is single-user.
   - **Local dev fallback:** `wrangler dev` has no Access in front, so a request with no
     Access header *and* a `localhost`/`127.0.0.1` hostname falls back to a fixed
     `local-dev` owner. Production traffic can never present a localhost hostname (Access
     fronts the real domain), so the fallback can't be reached in prod.
   - **Hardening path (not done):** validate the `Cf-Access-Jwt-Assertion` JWT against the
     team JWKS to be spoof-proof even if the Worker were ever reachable bypassing Access.
     For v1, Access fronting the hostname is the security boundary.

3. **Data layer = query collection over `/api/nodes`.** `collection.ts` swaps
   `localStorageCollectionOptions` → `queryCollectionOptions`. The collection interface
   (`insert`/`update`/`delete`/`subscribeChanges`/`toArray`) is unchanged, so the tree
   store, mutations, and components are untouched — ADR 0014 still holds.
   - `queryFn` GETs the **complete** node set for the owner (returning a partial set would
     make the collection delete the rest).
   - Mutation handlers map over **all** of `transaction.mutations` (a structural move
     relinks several siblings) and POST/PATCH/DELETE a batch; the Worker runs them as one
     D1 `batch()`.
   - Handlers return **`{ refetch: false }`**: mutations are optimistic locally and
     persisted server-side, so a keystroke must not trigger a full re-GET. Cross-device
     edits reconcile on **window-focus refetch** (`refetchOnWindowFocus`, query-client.ts).
     This is the v1 sync cadence — *near-real-time on focus*, not live push.

4. **SQLite shape.** Booleans are stored `INTEGER` 0/1 and converted back to real booleans
   in the Worker's GET, so the client `nodeSchema` is unchanged (no transform fields). The
   flat `Node` row maps 1:1 to the `nodes` table (`migrations/0001_create_nodes.sql`).

5. **Seed is now async-idempotent.** The old localStorage seed read the raw key
   synchronously, so a double-mounted effect saw the just-written rows and skipped. The
   D1 path is async; two effect invocations (StrictMode / Start's dev client re-mount)
   would both await an empty collection and both seed (observed: 8 rows instead of 4). A
   module-level `seedStarted` flag set **before** the first `await` closes the race.

## Dev loop

`bun run dev` (Vite, HMR) proxies `/api` to `bun run dev:api` (`wrangler dev` on :8787,
Worker + local D1). Run both. First time: `bun run db:migrate:local`. `bun run cf:dev`
gives a production-like single-server preview. The React app always calls the relative
`/api/nodes`, so it's environment-agnostic; only the proxy differs in dev.

## Rejected alternatives

- **No identity / one global table** — wrong product (everyone shares one outline).
- **Postgres + ElectricSQL** (the README's original sketch) — real-time out of the box,
  but not D1 and not Cloudflare-native; Electric must be hosted elsewhere. Off-goal.
- **App-level accounts (sign-up/login/sessions)** — the right call if this ever goes
  public/multi-user, but a project, not a step. Access is far less code for single-user.
- **Durable Objects for real-time push** — deferred. Window-focus refetch is enough for
  one user across devices; revisit when live cursors / instant multi-device push matter.
- **Anonymous share-by-URL space id** — no real security; rejected for a personal tool.

## Known limitations / follow-ups

- **The Playwright e2e suite was reworked to match (done).** It used to seed a tree into
  `localStorage` (`e2e/fixtures.ts`), which the app no longer reads. `seedOutline` now
  `page.route`-intercepts `/api/nodes` with an in-memory `Map` mock of the Worker's
  contract (GET=full set, POST upsert, PATCH `{updates}`, DELETE `{ids}`), so the real
  `collection.ts`/`api.ts` query+mutation path runs against a Map instead of D1 — no
  `wrangler dev` needed, and per-`page` isolation keeps `fullyParallel` safe. All 39 specs
  pass with zero spec changes (only `fixtures.ts` changed). The Worker's own SQL is not
  covered here (typecheck:worker + manual verification); a Worker integration test against
  a local D1 is a possible later add.
- **Side-collections are still localStorage-only.** Tag colors (`tag-colors.ts`) and the
  daily index (`daily-index.ts`) are *not* synced to D1 yet, so on a second device tag
  colors and daily-note identity won't follow. Each is a future per-collection sync.
- **No localStorage → D1 data import.** A user with an existing local outline starts fresh
  in D1 (their localStorage is left intact, just unread). A one-time import is a small,
  separate follow-up.
- **Deploy-time human steps:** configure Cloudflare Access on the zone, and
  `bun run db:migrate:remote` before the first `bun run deploy`.
