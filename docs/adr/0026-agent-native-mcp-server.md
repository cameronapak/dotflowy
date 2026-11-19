---
status: accepted
---

# The agent-native MCP server

**What.** The Worker exposes the outline to AI agents over the Model Context Protocol: `POST /mcp`
(the ecosystem-default path clients probe; `/api/mcp` stays a working alias), stateless Streamable
HTTP, authenticated with real OAuth 2.1. It initially served eight tools — `get_outline`,
`search_nodes`, `add_node`, `update_node`, `delete_node`, `add_to_today`, `mirror_node`,
`mirror_to_today`. The posture is **agent-native**: whatever a human can do in the editor an agent can
do through the same data path, within reason — an agent's write lands in the per-user DO through the
same atomic `applyBatch` as an editor keystroke and broadcasts over the same sync socket, so a
connected editor sees the agent's edit live, exactly like a second device.

The current tool contracts live in [the registry](../../worker/mcp-tools.ts);
clients discover them through `tools/list`. See [the MCP guide](../mcp.md) for
the current tool surface. The original list above records this decision's scope,
not a limit on later tools.

## Decisions

**Transport: hand-rolled stateless JSON-RPC in Effect, not `McpServer.layerHttp`, not the official
SDK.** Effect v4 ships a full MCP server (`effect/unstable/ai/McpServer`) and using it was the default
candidate under [ADR 0021](./0021-effect-first-one-schema-language.md). Rejected on runtime grounds,
same prove-don't-assume discipline as [ADR 0024](./0024-httpapi-transport-deferred.md): its HTTP layer
(and the official SDK's stateful mode) keeps per-client session state in an in-memory `Map` keyed by
`Mcp-Session-Id`, and Workers isolates are neither long-lived nor sticky — the follow-up POST that
lands on a fresh isolate finds no session and dies. Running that layer _inside_ the DO would pin state
but drags Effect's RPC runtime into the DO ([ADR 0023](./0023-do-storage-stays-native.md) posture) and
still loses sessions on hibernation. The spec's **no-session stateless mode** fits Workers exactly:
every POST is self-contained, `initialize` returns no session id, GET streams decline with 405. The
protocol surface we need (initialize / ping / tools) is ~250 lines of `worker/mcp.ts` — one Effect
pipeline, `Data.TaggedError`-free because every failure IS a well-formed JSON-RPC response.

_Amended 2026-07-25:_ **the runtime objection above no longer holds against the official SDK v2, and
the plan is to adopt it — gated, not now.** The TS SDK v2 (`@modelcontextprotocol/server`, beta at
this writing, targeting the 2026-07-28 revision) is per-request-native: `createMcpHandler`, a
web-standard Streamable HTTP transport, workerd shims. And the 2026-07-28 spec itself removes
protocol sessions entirely (SEP-2567/2575 — no `Mcp-Session-Id`, no `initialize` handshake): the
stateless posture this ADR chose against the SDK is now the spec's own default. What changes the
adoption calculus is the size of the 2026 era's wire change — `initialize`/`ping` removed, a
mandatory `server/discover` RPC, `Mcp-Method`/`Mcp-Name` request headers, a required `resultType` on
every result, required `ttlMs`/`cacheScope` cache hints on `tools/list` — while clients will straddle
eras for years (the spec adopted a 12-month-minimum deprecation policy). Dual-era serving is exactly
where hand-rolled stops being ~250 lines; the SDK automates era negotiation, envelope lifting, and a
legacy shim that serves both eras from one handler. **Adopt when three gates clear:** (1) v2 is
stable, not beta; (2) Effect Schema plugs into v2's Standard Schema path with JSON-schema publication
intact (v2 accepts Standard Schema; verify the `StandardSchemaWithJSON` interop, e.g. via
`Schema.toStandardSchemaV1` + `Schema.toJsonSchemaDocument`) so the schema-is-the-validator rule
survives without a second schema language ([ADR 0021](./0021-effect-first-one-schema-language.md));
(3) the DCR deprecation's auth story settles (next amendment). Until then the hand-rolled server
stays — every mainstream client still negotiates the 2025 era today, and `worker/mcp.ts` answers
`2025-06-18` correctly to a `2026-07-28` request (offer-latest-supported is the spec's negotiation).

**The tool schema is the validator ([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)'s rule,
extended to tools).** Each tool's input contract is an Effect Schema; `tools/list` publishes
`Schema.toJsonSchemaDocument(input)` and `tools/call` decodes against the same value, so the contract
an agent reads and the gate its arguments pass can't drift. Tool-level refusals (protected node, mirror
cycle, missing id) and store faults surface as `isError` tool results — inside the protocol, where the
agent can read and react to them, carrying their real reason. (Amended 2026-08-08: store faults
originally collapsed to a bare `-32603` "so internals never leak", which hid a whole class of shard
failures from the one agent able to report them. The endpoint serves a single bearer-authenticated
user whose store is scoped to their own DO, so there is no cross-tenant reader to
hide internals from.) Only unexpected non-store defects still collapse to a bare `-32603`.

**Writes are planned purely, committed atomically.** `worker/outline-ops.ts` is the Worker-side twin of
the client's `mutations.ts`: pure functions from a snapshot `TreeIndex` to a `ChangeOp[]` batch, with
ids and timestamps passed in (deterministic, `bun test`-able — the tests cover the chain surgery the
same way `sibling-chain.ts`'s do). Tree semantics are **imported from `src/data/tree.ts`** — the same
`buildTreeIndex`/`childrenOf`/`trueSourceOf`/`wouldMirrorCycle`/`orphanedMirrorsBy` the client uses
(the `wire-schema.ts` cross-tsconfig pattern), so the two sides can't drift. Every mutation commits as
ONE `applyBatch` frame ([ADR 0009](./0009-atomic-structural-writes.md)); the daily get-or-create claims
its ids through the DO's atomic `getOrCreateKv` first (the client's `claimMapping` race-killer), then
materializes missing nodes in the same batch as the add/mirror. The client's semantics carry over
wholesale: mirror content edits follow the true source, mirrors flatten and refuse cycles
([ADR 0022](./0022-node-mirrors.md)), deletes that would orphan mirrors are blocked (v1 protects), and
the daily container's protection rules ([ADR 0015](./0015-protected-nodes.md)) are enforced
server-side — an agent can't delete, blank, task-ify, or complete it.

**Amended by [ADR 0086](./0086-scoped-expiring-api-keys.md):** manually configured
personal API keys can also authenticate MCP, with server-enforced read-only or
read/write permissions. OAuth discovery and browser-session separation remain.
The paragraph below records the original OAuth-only decision.

**Historical OAuth design (superseded by the 1.7 amendment below): Better Auth's `mcp` plugin, not API keys, not the session cookie.** MCP clients speak OAuth
2.1 (PKCE + dynamic client registration + RFC 9728 discovery), and Better Auth — already the identity
layer ([ADR 0011](./0011-the-auth-gate.md)) — ships all of it as the `mcp` plugin: authorization/token/
registration endpoints under `/api/auth/mcp/*`, tokens in D1 (migration `0004`), `getMcpSession` for
bearer validation. The Worker serves the two discovery documents at the **site root** (spec requirement;
`worker/index.ts` routes them before the assets shortcut, and matches them by PREFIX so RFC 9728
path-aware probes like `/.well-known/oauth-protected-resource/mcp` resolve to the same
path-independent metadata) and gates `/mcp` on the bearer token —
whose `userId` routes through the same `resolveUserId` to the same per-user DO as a browser session.
One identity model, two credentials. Rejected: hand-rolled API keys (a second auth system, and
mainstream MCP clients wouldn't discover it) and cookie-session auth on `/mcp` (no MCP client has
the cookie, and it would drag CSRF concerns onto an endpoint meant for non-browser callers).

**The SPA's AuthScreen doubles as the OAuth login page.** A signed-out authorize redirects to `/` with
the OAuth query intact; after sign-in the AuthScreen resumes with a **top-level navigation** back to
the authorize endpoint (the code must reach the client's `redirect_uri` as a real redirect — the
plugin's after-hook fires on the sign-in _fetch_, whose cross-origin 302 a browser fetch can't
reliably deliver). The original implementation auto-issued codes without a consent page.

_Amended 2026-11-14:_ **Public connector readiness requires explicit consent and user-owned revocation.**
Every new authorization forces `prompt=consent` server-side and uses `/mcp-consent`
outside the editor shell. Display data comes from unexpired provider state and the
registered callback, never consent-page query labels. Consent checks bind the pending
code to the session's user; the token endpoint rejects pending consent codes (the
Better Auth 1.6 MCP handler otherwise accepts them). Denial preserves OAuth state
and existing callback query parameters. Approval transitions live pending state and
saves consent in one conditional D1 transaction, so a concurrent revocation cannot
restore consent through a stale approval. Non-string authorization codes are rejected
before the provider can coerce them. New grants require S256 PKCE.

`/api/mcp-connections` is browser-session-only. A same-origin DELETE atomically
removes this user's tokens, consents, and pending codes for a client, never the shared
registration or a neighbor's grants. Settings exposes revocation even on Free.
Revoking an app or personal API key from Settings requires native browser confirmation.
Existing credentials remain accepted without retroactive consent and can still refresh. A
successful refresh consumes the old grant; competing refreshes cannot both succeed.
The code exchange also checks that consent still exists after token creation, so a
revocation during issuance cannot leave a new credential behind.
Revocation cannot undo requests already authorized or delete client-held copies.

Protected-resource metadata now uses the **full endpoint URL**, including `/mcp`,
not the origin-only identifier in the original decision above. Root discovery remains
for older clients; path-aware `/api/mcp` metadata describes that retained alias.
No token-format, identity, storage, SDK, or CIMD migration is part of this amendment.

Tool hints follow actual behavior: moves are non-additive structural changes and
therefore destructive; creates, mirrors, and additive OPML imports remain false.
Only text-authoring tools with public link-title enrichment advertise open-world
interaction. Hints never substitute for permission enforcement.

References: [Claude authentication](https://claude.com/docs/connectors/building/authentication),
[review criteria](https://claude.com/docs/connectors/building/review-criteria), and
[MCP ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations).

_Amended 2026-07-25:_ **DCR is deprecated upstream; Better Auth isn't ready for the successor yet —
watch, don't move.** The 2026-07-28 spec deprecates RFC 7591 Dynamic Client Registration in favor of
Client ID Metadata Documents (CIMD, URL-shaped client ids), keeping DCR available for backwards
compatibility through the 12-month-minimum deprecation window. On the Better Auth side, the `mcp`
plugin this ADR chose is itself slated for deprecation in favor of their `oauth-provider` plugin —
which as of 2026-07-25 still speaks only DCR (CIMD explicitly not yet implemented). Nothing breaks
today: clients keep registering via DCR. When Better Auth ships CIMD (likely in `oauth-provider`),
migrate the plugin and re-verify the two `/.well-known` discovery routes and the AuthScreen resume
flow. This gate also holds back the SDK v2 adoption above — v2 marks `registerClient` deprecated in
lockstep with the spec.

**Dates are the caller's problem, explicitly.** The daily tools take an optional `date` (`YYYY-MM-DD`)
that defaults to UTC-today, and the tool description tells the agent to pass the user's local date —
the Worker cannot know the user's timezone, and inventing one server-side would silently file
late-evening captures under tomorrow. Same local-midnight philosophy as `localDateKey`, honestly
delegated. (Amended 2026-08-09: `add_to_today` and `mirror_to_today` also take an optional `timeZone`
IANA parameter — when `date` is omitted, "today" resolves in that zone via `Intl.DateTimeFormat`, the
server twin of `localDateKey`; an explicit `date` still wins, and a malformed zone is a loud `isError`,
never a silent UTC fallback. `add_subtree` and `import_opml` accept the same parameter but only reach
the daily path when a `date` is given, so for them it is validated and ignored.)

## Considered and rejected

- **Effect `McpServer.layerHttp` / official SDK stateful mode** — in-memory sessions don't survive
  stateless isolates (above). _Amended 2026-07-25:_ this held against SDK **v1**; SDK v2 is
  per-request-native and the objection is retired — v2 adoption is now planned behind the three
  gates in the transport amendment, so this rejection is historical, not standing.
- **MCP server inside the Durable Object** — pins session state but bloats the DO with an RPC runtime
  and still loses it on hibernation; the DO stays storage-only.
- **A `move_node` / full structural tool set in v1** — the asked-for surface is capture + mirror +
  edit; move/indent/reorder can follow once real agent usage shows the need. (Move landed as
  `move_nodes` in [ADR 0027](./0027-mcp-move-nodes.md).)
- **Deriving "today" server-side from a stored user timezone** — new schema + settings surface for
  something the calling agent already knows better. (The 2026-08-09 amendment above keeps this
  rejected: the timezone travels as a per-call parameter, never as stored per-user state.)

## Consequences

- New D1 migration `0004_create_oauth.sql` (`oauthApplication` / `oauthAccessToken` / `oauthConsent`,
  written from the plugin's schema in `0003`'s conventions). Run `db:migrate:remote` before deploying.
- `BETTER_AUTH_URL` matters more: it is the OAuth **issuer** in the discovery metadata. `createAuth`
  falls back to the request origin when it's unset (correct on any single deployment), but pinning it
  in prod is the stable configuration. Local `wrangler dev` testing of the OAuth flow wants it in
  `.dev.vars` (the dev proxy's custom-domain simulation makes the inferred origin `app.dotflowy.com`).
- The MCP surface is unit-tested end to end below auth (`worker/mcp.test.ts` drives the HTTP handler
  against an in-memory store; `worker/outline-ops.test.ts` covers the planners) — e2e can't reach it
  (`seedOutline` mocks the Worker and MCP has no browser caller), the same carve-out as
  `worker/wire.test.ts`.
- The tool registry is compile-time static, like the plugin registry
  ([ADR 0001](./0001-plugin-architecture.md)): adding a tool = one entry in `worker/mcp-tools.ts`
  (schema + handler), and `tools/list` derives itself.

## Better Auth 1.7 migration

The authorization server now uses `@better-auth/mcp`, built on
`@better-auth/oauth-provider`, with opaque SHA-256-hashed tokens. Migration
`0023_better_auth_1_7.sql` follows the vendor reset path: remove old OAuth
verification state, drop the three legacy OAuth tables, and create the 1.7
client, resource, consent, access-token and refresh-token models. Existing agent
registrations and credentials are intentionally invalidated; agents reconnect
once. Users, browser sessions, API keys and outline routing are unaffected.

Both `/mcp` and `/api/mcp` remain public MCP URLs. Root and path-aware
`/.well-known/oauth-protected-resource` documents remain available, as does
`/.well-known/oauth-authorization-server` (including issuer-path discovery).
The issuer is now the provider's `<origin>/api/auth`; protected-resource metadata
advertises that issuer. Discovery retains the public `/api/auth/mcp/authorize`,
`/token`, and `/register` aliases, which dispatch internally to 1.7's
`/oauth2/*`. Resource requests for the origin or either MCP URL normalize to
`<origin>/mcp`; unrelated resources are rejected. PKCE remains mandatory.
The provider's active-token validator checks stored expiry/revocation and the
MCP audience; proof-bound tokens are not accepted as unbound Bearer tokens.
The resulting stable user id still passes through `resolveUserId`.

Explicit consent remains account-bound and required on every authorization.
The compatibility boundary keeps a short-lived, single-use opaque consent code
in D1, bound to the server session's user and the provider-signed OAuth query.
The browser never submits arbitrary redirects, scopes or a raw signed query to
approve access. Approval forwards the saved query to the official provider,
then tags the issued authorization code with the current revocation generation.

D1 has no interactive transactions for provider rotation. Rotation uses the
provider's conditional one-time update, with `refreshTokenReuseInterval: 0`:
replaying a rotated refresh token invalidates the user's client family, not
just the old credential. An `mcpGrant` generation and refresh-deletion trigger
mitigate the provider's documented family-invalidation/rotation insertion window.
Disconnect increments the generation and deletes access tokens, refresh tokens,
consents and pending codes in one D1 batch. Token issuance snapshots the
generation and checks it after insertion; a stale candidate pair is deleted
before a response is returned. Refresh also invalidates the prior access token.
The same check prevents an approval or code exchange from restoring a revoked
grant. Account deletion removes both token models, consent, client-resource
links, owned clients, grant generations and pending OAuth verification state.
This is a D1-specific mitigation, not an interactive transaction across provider
operations. Tests inject revocation during approval, exchange and rotation;
they do not exhaust all multi-worker interleavings. Revisit this boundary when
the provider supports atomic family invalidation.
An already-authorized MCP request may finish when revocation races its execution;
revocation cannot undo work already accepted by the outline DO.
