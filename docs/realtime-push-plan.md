# Handoff: real-time push + daily-note day-key uniqueness

> Forward-looking implementation plan for another agent. **Not** a shipped decision —
> `docs/DECISIONS.md` is for those. Delete this file once both workstreams land.

Two independent workstreams. They're complementary but ship separately:

- **A — Real-time push:** edits show on a user's other devices live, not on tab refocus. **✅ Tier 2 built + server-verified** (see below); pending a browser two-tab sign-off + deploy.
- **B — Daily-note day-key uniqueness:** kill the duplicate-daily-note bug at the source. **✅ shipped** (see below).

B was a real correctness bug and the smaller change — done first. A landed as the full Tier 2 (delta streaming), skipping the throwaway Tier-1 poke client.

> **Status:** Workstream B landed via a generic server-authoritative atomic kv claim
> (`getOrCreateKv` in `worker/outline-do.ts` → `/api/kv?op=claim` in `worker/index.ts` →
> `kvGetOrCreate` in `src/data/kv-api.ts`), consumed by a claim-first get-or-create in the
> daily plugin (`claimMapping`/`refetchNodes` in `daily-index.ts`, async `ensureContainer`/
> `ensureDay`/`getOrCreateDay`/`goToDate` in `index.tsx`). Explicit-id inserts added to
> `mutations.ts`. e2e: the kv mock now serves `?op=claim`, plus a "lost claim adopts the
> winner" race spec. typecheck/typecheck:worker/build/test:e2e all green. **Don't delete this
> file until A also lands.**

---

## Shared context (read these first)

- `src/data/collection.ts` — `nodesCollection` is a TanStack DB **query collection**
  (`queryCollectionOptions`, `queryKey: ['nodes']`). Mutation handlers return
  `{ refetch: false }`, so writes do **not** re-GET. The only cross-device sync trigger
  today is window focus.
- `src/data/query-client.ts` — one `QueryClient`, `refetchOnWindowFocus: true`,
  `staleTime: 0`. A refetch is `queryClient.invalidateQueries({ queryKey: ['nodes'] })`.
- `src/data/api.ts` / `src/data/kv-api.ts` — same-origin REST clients; the Better Auth
  session cookie rides along automatically.
- `worker/index.ts` — gates `/api/*` by `auth.api.getSession`, resolves the caller's DO via
  `resolveUserId(session.user.id, env)`, forwards to it. `/api/auth/*` is Better Auth.
- `worker/outline-do.ts` — `UserOutlineDO` (per-user SQLite). Outline mutations arrive as
  **RPC methods** (`upsertNodes`/`patchNodes`/`deleteNodes`); side-collections as
  `getKv`/`upsertKv`/`deleteKv`. The `kv` table has `PRIMARY KEY (collection, key)`. The DO
  is **single-threaded per user** — every one of that user's devices hits the same instance,
  serialized. There is **no `fetch()` and no WebSocket handling yet**.
- Side-collections (`tag-colors`, `daily-index`) are query collections over `/api/kv`.

---

## Workstream B — Daily-note day-key uniqueness ✅ SHIPPED

### The bug (was)
Get-or-create was **client-side against a stale-prone replica**: two devices both missed the
day key locally, both minted a node, and the second `setMapping` overwrote the first — two
day-nodes under "Daily", index pointing at one. Same race on the container. Real-time push
(Workstream A) would *narrow* the stale window but not close it — the atomic claim is the fix.

### What landed
A **generic server-authoritative atomic claim** on the kv seam — the DO never learns what
"daily" is, it just gains an atomic op on its existing `kv` table:

- **DO** `getOrCreateKv(collection, key, value)` (`worker/outline-do.ts`): `INSERT … ON CONFLICT
  DO NOTHING` then `SELECT` — pre-existing value wins. Atomic because the DO is single-threaded
  across all the user's devices.
- **Worker** `POST /api/kv?collection=<c>&op=claim` (`worker/index.ts`), under the same session
  gate + `KV_COLLECTIONS` allowlist → `json({ value })`.
- **Client** `kvGetOrCreate<T>()` (`src/data/kv-api.ts`) — throws like its siblings (its caller
  is the errore boundary).
- **Daily plugin** (`src/plugins/daily/`, the only daily-aware change): `claimMapping` +
  `refetchNodes` in `daily-index.ts`; async claim-first `ensureContainer`/`ensureDay`/
  `getOrCreateDay`/`goToDate` in `index.tsx`. The 3 call sites (Today button, `/` command,
  Cmd+K Seam-J action) now await.
- **mutations.ts** gained explicit-id inserts (optional trailing `id` on `insertChildAtStart` /
  `appendChild`) so a claim **winner** creates the node under the claimed id and two devices
  healing the same day converge on one id.

### Deviations from the original sketch (intentional)
- **Fast path:** when the day/container is already in the local replica, return it **without a
  claim round-trip** (no network on the common case; the claim only fires when local shows
  absent — exactly the race window). So "go to today" pays one RTT only on first-create.
- **Claim value is the full `{ key, nodeId }` row**, not a bare id — keeps the kv value
  consistent with what `dailyIndexCollection` reads back.
- **Loser path:** adopt the winner's id, `setMapping(winner)`, and `refetchNodes()` only if the
  winner's node isn't local yet (best-effort self-heal; the rest heals on the next nodes
  refetch / once Workstream A lands). Chose claim-first over create-then-rollback (no node ever
  briefly exists).
- **Graceful degradation:** if the claim network call fails, `claimMapping` logs and falls back
  to the optimistic local create (old behavior) — the feature keeps working, the rare failure
  window just reopens the pre-fix race (no worse than before).

### Verified
- typecheck + typecheck:worker + build (incl. `/` prerender) clean; **all 47 e2e green**.
- The kv mock (`e2e/fixtures.ts`) now serves `?op=claim` with real get-or-create semantics, so
  every daily test exercises the claim path; a new `daily-notes.spec.ts` case ("a lost claim
  adopts the winner's note") forces `?op=claim` to a fixed winner and asserts **no duplicate**.

---

## Workstream A — Real-time push

> **Status: ✅ Tier 2 BUILT + server-verified.** Went straight to delta streaming
> (no throwaway Tier-1 poke client). What landed:
> - **DO** (`worker/outline-do.ts`): a monotonic `seq` (in `meta`) + a bounded
>   `changelog` table (last 1000 batches); `upsertNodes`/`patchNodes`/`deleteNodes`
>   record ops and `commitChange` broadcasts `{type:'change',seq,ops}` over
>   `ctx.getWebSockets()`. WS via **Hibernation** (`ctx.acceptWebSocket`, never
>   `ws.accept()`): `fetch()` returns 101; the client drives a `hello{since}`
>   handshake and `webSocketMessage` replies `snapshot` (full state) or `resume`
>   (the gap since the cursor, snapshot fallback past the window).
> - **Worker** (`worker/index.ts`): `GET /api/sync` upgrade, session-gated, seeds
>   the owner first (the live client no longer GETs `/api/nodes`), forwards
>   `stub.fetch(request)`.
> - **Client**: `src/data/realtime.ts` (socket transport — connect, hello,
>   reconnect/backoff, hello-timeout, `onInitialError`, `resync`) + `collection.ts`
>   swapped from `queryCollectionOptions` to a **custom sync** collection
>   (snapshot→`truncate`+write, deltas via `begin/write/commit`, resume cursor in
>   `metadata.collection`). Write path unchanged (POST/PATCH/DELETE). `nodesLoadError`
>   repointed off the query client; daily's `refetchNodes` → `resyncNodes`.
> - **e2e**: `routeWebSocket('/api/sync')` serves the snapshot from the Map mock;
>   all 47 specs green. typecheck + typecheck:worker + build (incl. `/` prerender)
>   clean.
> - **Live-verified** vs `wrangler dev` (a throwaway Bun script, now removed): a REST
>   write broadcasts a `change` delta to **both** authed sockets; a reconnect with a
>   stale cursor **replays** the missed change via the changelog. Two-context browser
>   sign-off + `deploy` still pending (no D1 migration needed — the DO creates its
>   `changelog`/`seq` on next wake via `CREATE TABLE IF NOT EXISTS`).
> - **Deviation from the sketch below:** `hello`-first handshake (only-documented
>   Hibernation behavior) instead of send-before-101; snapshot rides the socket
>   (one ordered channel, no snapshot/stream overlap race) instead of a GET.

### TL;DR
The per-user DO is the single hub all a user's devices talk to — the natural fan-out point via
**WebSocket Hibernation**. Both tiers run on the **same socket infrastructure**; Tier 2 only
changes how the *client* consumes the broadcast (refetch → apply deltas). **Ship Tier 1 first.**

### Cost — why this stays budget-friendly (verified vs CF pricing, 2026-06)
Leading with this because it's the deciding constraint. Workers Paid ($5/mo base — already on it):

| Meter | Included / mo | Overage | Covers |
| ----- | ------------- | ------- | ------ |
| Requests | 1 M | $0.15/M | HTTP + RPC + **WS messages** + alarms |
| Duration | 400,000 GB-s | $12.50/M GB-s | billed at 128 MB/DO **while active** |
| SQLite rows read | 25 B | $0.001/M | — |
| SQLite rows written | 50 M | $1.00/M | — |
| SQLite storage | 5 GB | $0.20/GB-mo | — |

The three facts that make real-time nearly free here:
- **Idle hibernated connections are NOT billed for duration** (CF, verbatim). N tabs sitting open
  connected = **$0 duration**. This is the whole reason it's cheap.
- **Outgoing WS messages are free.** Our broadcasts (the poke, or the deltas) cost **nothing**.
- **Incoming WS messages bill 20:1** as requests (100 msgs = 5 billable). We send almost none
  client→server — the runtime answers protocol pings for free, and writes still ride the existing
  HTTP path, not the socket.

Net for this app (personal outline, small base):
- Broadcasts are free; the writes that trigger them are **already billed today** (the POST/PATCH
  to `/api/nodes`), and the broadcast piggybacks on that already-active DO window → negligible
  added duration.
- Only NEW billable traffic: ~1 request per socket **connect** (tab open / reconnect), plus —
  **Tier 1 only** — a refetch GET per remote change. A client debounce (coalesce pokes in ~250 ms)
  keeps those near/under the 1 M included; even 100 users editing all day is **pennies** of
  overage. SQLite limits aren't remotely in play.
- **Bottom line: ~$0 over the existing $5/mo at this scale.**

> **The one budget rule (non-negotiable):** use the **Hibernation API** (`ctx.acceptWebSocket`),
> NEVER plain `ws.accept()`. `accept()` bills duration for the *entire* time each socket stays
> connected — with always-open tabs that's continuous GB-s burn, the single way to make this
> expensive. Both tiers use Hibernation.

### The mechanism (confirmed Hibernation API)
- **Accept:** in the DO's `fetch()`, on an `Upgrade: websocket` header:
  `const { 0: client, 1: server } = new WebSocketPair(); this.ctx.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client })`.
- **Handlers are DO METHODS, not `addEventListener`:** `webSocketMessage(ws, msg)`,
  `webSocketClose(ws, code, reason, wasClean)`, `webSocketError(ws, err)`.
- **Broadcast:** `for (const ws of this.ctx.getWebSockets()) ws.send(JSON.stringify(msg))` — free
  (outgoing).
- **Keepalive:** the runtime auto-answers protocol pings; no app-level ping/pong needed.
- **Per-socket state** (Tier 2's resume cursor): `ws.serializeAttachment(v)` / `deserializeAttachment()`
  (≤ 16 KB), survives hibernation.

### Tier 1 — the "poke" (build first)
The socket carries **no data**, just "something changed, refetch." The whole pull model stays.

**DO (`worker/outline-do.ts`):**
1. Add `fetch()` handling the WS upgrade (accept pattern above), return `101` with the client socket.
2. Add `private broadcast(msg)` → iterate `this.ctx.getWebSockets()` and `ws.send(JSON.stringify(msg))`.
3. Call `broadcast({ type: 'invalidate', collection: 'nodes' })` at the **end** of `upsertNodes` /
   `patchNodes` / `deleteNodes` (and the kv methods if/when kv is scoped in — same poke, different
   `collection`).
4. `webSocketClose` / `webSocketError` → just `ws.close()`; Hibernation owns the socket set, so
   there's no per-socket state to clean in Tier 1.

**Worker (`worker/index.ts`):** add `GET /api/sync` (with `Upgrade: websocket`) that **validates
the session first** (same `getSession` gate — never open an unauthenticated socket), resolves the
user's DO via `resolveUserId`, and forwards the upgrade: `return stub.fetch(request)`. (Goes
through the auth gate naturally — the public-shell short-circuit only catches non-`/api` paths.)

**Client:** new `src/data/realtime.ts` — open a `WebSocket` to same-origin `/api/sync`
(`wss://` in prod, `ws://` on localhost; the Better Auth cookie rides the handshake), **browser
only**, from an effect. On `{ type: 'invalidate' }` → **debounced** (~250 ms)
`queryClient.invalidateQueries({ queryKey: ['nodes'] })`. On (re)connect, invalidate once (catch
anything missed offline). Reconnect with exponential backoff. Mount once inside `AuthGate`.
`collection.ts`, mutations, tree store, and components are **untouched**. Blast radius ≈ 80 lines.

Self-healing: reconnect always refetches full truth; echoing a poke to the originator is harmless
(idempotent refetch of its own write — no need to skip the originator).

### Tier 2 — delta streaming (graduate later, only if the refetch-per-change ever feels heavy)
Socket carries the changed rows; client applies deltas with **no refetch**. **Reuses 100% of
Tier 1's socket infra** (DO accept, Worker upgrade, auth-on-upgrade, reconnect) — only the client's
consumption and the broadcast payload change.

- **DO:** broadcast `{ type: 'change', seq, ops: [{ op:'insert'|'update'|'delete', value | key }] }`
  instead of the bare poke. Add a monotonic `seq` (a counter in the DO's `meta` table) so clients
  can detect gaps. Optionally keep a small bounded change-log table for replay.
- **Client (`collection.ts`):** swap `queryCollectionOptions` → a **custom sync collection**
  (`createCollection` with a custom `sync`). Pattern (from `db-core-custom-adapter`): subscribe to
  the WS **first** and buffer; fetch the initial snapshot (GET `/api/nodes`, or have the DO send a
  snapshot frame on connect); `begin/write/commit` the snapshot; `markReady()`; replay the buffer;
  then apply each delta via `begin/write/commit`. `rowUpdateMode: 'partial'` (a PATCH carries only
  changed fields). The **write path is unchanged** — `onInsert/onUpdate/onDelete` still POST/PATCH/
  DELETE.
- **Missed-message replay:** store the last `seq` in `metadata.collection` (a resume cursor); on
  reconnect send `?since=<seq>`. If the DO can serve the gap from its log, stream it; if `since` is
  unknown/too old, fall back to a **full resync** (one GET) — simplest correct behavior.
- **Originator skip:** unnecessary — the originating tab's optimistic mutation is already applied,
  and its own echoed delta reconciles idempotently. Add a client-tag skip only if profiling shows
  it matters.
- **Cost note:** Tier 2 is marginally *cheaper* (drops the per-change refetch GET, smaller
  payloads) but the difference is noise at this scale. Do Tier 2 for UX/scale, **not** for budget.

### Decisions (recommendations)
1. **Tier 1 first** — same felt result for a personal outline, ~80 lines, zero collection refactor.
2. Scope → **nodes only** for v1; add kv later (same poke, `collection` field).
3. Route → one unified `/api/sync` per user (the same per-user DO as REST).
4. Originator echo → broadcast to all; the echo is a harmless idempotent refetch.
5. **Hibernation API only** — the budget rule above.

### Done when
**Tier 1:**
- Two contexts for one account; an edit in one appears in the other within a moment, **no refocus**.
- `typecheck` + `typecheck:worker` + `build` clean; `test:e2e` still green, plus a **live
  two-context test against `wrangler dev`** (the Map-mock harness can't exercise a real socket —
  don't force it through there).

**Tier 2 (additionally):**
- Steady-state edits apply as deltas with **no full refetch** (verify in the network panel).
- Reconnect after going offline **replays missed changes** via the resume cursor (or cleanly falls
  back to a full resync), with no duplicate/orphan rows.

---

## Shared constraints / gotchas
- **Auth on the WS upgrade:** validate the session in the Worker *before* forwarding to the DO. The
  socket connects to the **same per-user DO** as REST (`resolveUserId`).
- **SPA / no-SSR rule:** the WS client must run **only in the browser**. Opening it during the
  prerender of `/` breaks `bun run build`. Guard with an effect / `typeof window` check (see how the
  tree store avoids server access). Same for any `Date.now()`-style call in render.
- **Hibernation, not the legacy WS API:** use `ctx.acceptWebSocket` + `webSocketMessage` /
  `webSocketClose` / `webSocketError`, not `addEventListener` — confirmed against CF docs (see "The
  mechanism" above). This is also the **budget rule**: plain `ws.accept()` bills duration for the
  whole connection lifetime; Hibernation bills $0 for idle sockets.
- **errore convention:** this repo uses errors-as-values (errore.org). Read the `errore` skill
  before touching error paths.

## Skills to load
`durable-objects` (WebSocket Hibernation — primary for A), `workers-best-practices`, `wrangler`,
`errore`. Tier 2 only: `db-core-custom-adapter`, `db-core-collection-setup`, `react-db`.
