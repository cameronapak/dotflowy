---
status: accepted
---

# The agent-native MCP server

**What.** The Worker exposes the outline to AI agents over the Model Context Protocol: `POST /mcp`
(the ecosystem-default path clients probe; `/api/mcp` stays a working alias), stateless Streamable
HTTP, authenticated with real OAuth 2.1, serving eight tools — `get_outline`,
`search_nodes`, `add_node`, `update_node`, `delete_node`, `add_to_today`, `mirror_node`,
`mirror_to_today`. The posture is **agent-native**: whatever a human can do in the editor an agent can
do through the same data path, within reason — an agent's write lands in the per-user DO through the
same atomic `applyBatch` as an editor keystroke and broadcasts over the same sync socket, so a
connected editor sees the agent's edit live, exactly like a second device.

## Decisions

**Transport: hand-rolled stateless JSON-RPC in Effect, not `McpServer.layerHttp`, not the official
SDK.** Effect v4 ships a full MCP server (`effect/unstable/ai/McpServer`) and using it was the default
candidate under [ADR 0021](./0021-effect-first-one-schema-language.md). Rejected on runtime grounds,
same prove-don't-assume discipline as [ADR 0024](./0024-httpapi-transport-deferred.md): its HTTP layer
(and the official SDK's stateful mode) keeps per-client session state in an in-memory `Map` keyed by
`Mcp-Session-Id`, and Workers isolates are neither long-lived nor sticky — the follow-up POST that
lands on a fresh isolate finds no session and dies. Running that layer *inside* the DO would pin state
but drags Effect's RPC runtime into the DO ([ADR 0023](./0023-do-storage-stays-native.md) posture) and
still loses sessions on hibernation. The spec's **no-session stateless mode** fits Workers exactly:
every POST is self-contained, `initialize` returns no session id, GET streams decline with 405. The
protocol surface we need (initialize / ping / tools) is ~250 lines of `worker/mcp.ts` — one Effect
pipeline, `Data.TaggedError`-free because every failure IS a well-formed JSON-RPC response.

**The tool schema is the validator ([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)'s rule,
extended to tools).** Each tool's input contract is an Effect Schema; `tools/list` publishes
`Schema.toJsonSchemaDocument(input)` and `tools/call` decodes against the same value, so the contract
an agent reads and the gate its arguments pass can't drift. Tool-level refusals (protected node, mirror
cycle, missing id) surface as `isError` tool results — inside the protocol, where the agent can read
and react to them; DO faults collapse to a bare `-32603` so internals never leak.

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

**OAuth: Better Auth's `mcp` plugin, not API keys, not the session cookie.** MCP clients speak OAuth
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
plugin's after-hook fires on the sign-in *fetch*, whose cross-origin 302 a browser fetch can't
reliably deliver). No consent page: the plugin auto-issues the code for a signed-in user, acceptable
for a single-user-instance posture; a consent screen is an easy later add (`oidcConfig.consentPage`).

**Dates are the caller's problem, explicitly.** The daily tools take an optional `date` (`YYYY-MM-DD`)
that defaults to UTC-today, and the tool description tells the agent to pass the user's local date —
the Worker cannot know the user's timezone, and inventing one server-side would silently file
late-evening captures under tomorrow. Same local-midnight philosophy as `localDateKey`, honestly
delegated.

## Considered and rejected

- **Effect `McpServer.layerHttp` / official SDK stateful mode** — in-memory sessions don't survive
  stateless isolates (above).
- **MCP server inside the Durable Object** — pins session state but bloats the DO with an RPC runtime
  and still loses it on hibernation; the DO stays storage-only.
- **A `move_node` / full structural tool set in v1** — the asked-for surface is capture + mirror +
  edit; move/indent/reorder can follow once real agent usage shows the need.
- **Deriving "today" server-side from a stored user timezone** — new schema + settings surface for
  something the calling agent already knows better.

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
