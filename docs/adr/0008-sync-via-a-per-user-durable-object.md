# Sync via a per-user Durable Object

One Cloudflare **Worker** (`worker/index.ts`) serves the static SPA *and* the sync API — `/api/nodes`
(the outline write path), `/api/kv` (plugin side-collections: tag colors, daily index), and
`/api/sync` (real-time outline reads). Each `/api` request is routed to the caller's **Durable
Object** (`UserOutlineDO`, `worker/outline-do.ts`), whose colocated **SQLite** holds that user's
entire outline plus the side-collections. Inside a per-user DO the `owner` column is gone — the DO
*is* the scope — and its single thread serializes a user's edits across devices, so there is no
last-write-wins reconciliation.

**Nodes sync live over WebSocket.** `collection.ts` is a TanStack DB *custom sync* collection
(`realtime.ts` → `/api/sync`): on connect the DO sends a `snapshot`, then every mutation on any
device arrives as a `{type:'change', seq, ops}` delta — no window-focus refetch. **Field** writes
PATCH `/api/nodes` optimistically and the socket echo reconciles idempotently; **structural** writes
go through one atomic batch instead (see [ADR 0009: Atomic structural writes](./0009-atomic-structural-writes.md)). Reconnect
sends `hello{since}`; the DO replies with `resume` (changelog gap) or falls back to `snapshot`.
The DO uses **WebSocket Hibernation** (`ctx.acceptWebSocket`, never legacy `ws.accept()`) — idle
connections bill $0 duration; outgoing broadcasts are free. **Side-collections** (tag colors,
daily index) stay query collections over `/api/kv` and still reconcile on tab focus.

**The DO routing key must never be an email.** A DO name is *permanent* (no rename), so keying it
off a mutable value would orphan a user's whole outline on an email or auth-provider change.
`resolveUserId()` returns the session's stable **`session.user.id`** (the lone exception is the
owner-continuity bridge, which maps one configured account back to the `'default'` DO — see [ADR 0011: the
auth gate](./0011-the-auth-gate.md)). Do NOT "fix" it to route off the email; that reintroduces exactly the
orphaning this avoids.

**D1 is kept, but demoted — it is no longer the outline store.** It serves two roles: (1) the home of
**Better Auth's identity tables** (`user`/`session`/`account`/`verification`; see [ADR 0011: the auth
gate](./0011-the-auth-gate.md)), and (2) the **source for the one-time, non-destructive import** of the
owner's pre-DO rows into the `'default'` DO (`ensureSeeded` reads D1 on the owner's first
`/api/sync` connect — a GET upgrade; the DO marks itself `seeded` and never re-imports). The
`migrations/` SQL files (and `db:migrate:*`) still apply to that D1; the DO's own schema (including
the realtime `changelog` table) is created in its constructor via `CREATE TABLE IF NOT EXISTS`, so
it has **no SQL migration file** — its wrangler migration is the `new_sqlite_classes` tag.

**Why a DO over D1-direct, or ElectricSQL/Postgres?** The browser can reach neither D1 nor a DO
directly — both are Worker bindings, so any of them needs the server tier. A per-user DO *also*
gives colocated storage (sub-ms reads next to compute), a single-writer thread that removes
conflict reconciliation, WebSocket Hibernation for live fan-out, and the natural home for subtree
sharing. Electric gives real-time out of the box but isn't Cloudflare-native (must be hosted
elsewhere) — off-goal for an all-Cloudflare deploy.

**Convergent public reference: Lunora (`lunora.sh`, alpha 2026).** An independent local-first
engine that lands on this same design — "the DO *is* the log" (an append-only changelog written in
the write's own storage transaction), the DO is the WebSocket fan-out, hibernation makes idle
sockets ~free, and the client runs the dataflow via TanStack DB while the DO ships row-ops rather
than re-running queries. Useful outside validation of ADR 0008/0009; two deliberate divergences
worth recording: (1) Lunora runs the write logic **authoritatively in the DO** (client keeps an
optional optimistic twin); we ship pre-computed `{ops}` from the client's `tree.ts` and validate
their *shape* at the trust boundary ([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md))
instead. We keep client-planned ops on purpose — single-writer-per-DO removes the concurrent-writer
conflicts that authoritative re-run buys, and the MCP path already re-plans server-side via the
shared `tree.ts` (`worker/outline-ops.ts`). (2) Lunora's **"shape = read-as-permission"** (the
client picks the partition, the server's `where` AND-composed with a row-level-security predicate
through one WHERE compiler picks the rows) is the pattern to reach for **when subtree sharing
lands** — partial replication and authorization as one mechanism, not a filter bolted next to an
auth check. Irrelevant today (one user = one DO = the whole outline), noted for the sharing seam.

**The SPA / no-SSR constraint lives here too:** the React app is a pure static SPA — never open the
sync socket or touch `nodesCollection` during a server/render pass (`collection.ts` guards with
`typeof window`; the tree store skips its subscription on the server; hooks supply
`getServerSnapshot` so `/` prerenders cleanly).

**Don't:** key the DO off an email/owner (permanent-name orphaning); reach for ElectricSQL or a
separate Postgres backend (off the all-Cloudflare goal); try to query D1 or a DO from the client
(impossible — both are Worker bindings); use legacy `ws.accept()` on the DO (bills duration for the
whole connection lifetime — the budget trap); have a snapshot return a *partial* node set (the
collection truncates on snapshot); or extract a generic `createKvCollection<T>` factory for
side-collections — each must pass its **concrete** Effect `Schema` inline (wrapped with
`Schema.toStandardSchemaV1`), or schema inference falls through to `Record<string, unknown>`.
