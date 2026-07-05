<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

<!-- codegraph:start -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source / docstring" | `codegraph_node` |
| "Give me focused context for a task/area" | `codegraph_context` |
| "Survey an unfamiliar module/topic" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

### Rules of thumb

- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **`codegraph_explore` is the heavy hitter** for unfamiliar areas — it returns full source from all relevant files in one call, but is token-heavy. If your harness supports parallel subagents (e.g., Claude Code's Task tool), spawn one for explore-class questions to keep main session context clean.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"*
<!-- codegraph:end -->

<!-- fff:start -->
For any file search or grep in the current git-indexed directory, use fff tools.
<!-- fff:end -->

## Vendored Effect v4 source

The project vendors the Effect v4 source at `repos/effect-smol/` (via `git subtree`).

- **Read-only reference.** Treat it as the source of truth for Effect v4 APIs, patterns, tests, and module structure. Never `node_modules/effect/` — always `repos/effect-smol/packages/effect/src/`.
- **Do NOT import from `repos/`.** Application and worker code continue to `import { Effect } from "effect"` from the normal npm dependency. The vendored copy is for agent reference only, not bundling.
- **Do NOT edit files under `repos/`.**
- Before writing Effect code, read `repos/effect-smol/AGENTS.md` and `repos/effect-smol/packages/effect/src/.patterns/effect.md` for v4 idioms (e.g. `Effect.fnUntraced`, `Effect.callback` not `Effect.async`, `Data.TaggedError("Tag")<{}>`, no `async/await`, use `Effect.gen`).
- Update with: `bun run repos:update-effect` (pulls from `Effect-TS/effect-smol.git main`).

## Agent skills

### Issue tracker

Issues and PRDs live as local markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles using the default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# Project Guidance

Guidance for coding agents working in this repo. `CLAUDE.md` is a symlink to this file.

`README.md` covers the data model, persistence, backend-swap path, and project layout — read it first and don't duplicate it here. This file is the non-obvious operational stuff: commands, gotchas, and the one rule per feature. The few decisions whose *why* isn't visible in the code live as numbered ADRs in [`docs/adr/`](./docs/adr/) — read the one a rule below points at.

## Local setup

**[`CONTRIBUTING.md`](./CONTRIBUTING.md) is the canonical setup + local-dev guide** — prerequisites, first-time setup, the two dev loops, the pre-PR gate matrix, and the MCP/OAuth local-testing gotcha. Don't re-derive the setup from scratch; follow it.

The short version, to get a working local instance:

```sh
bun install
cp .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
bun run db:migrate:local         # once: local D1 schema
bun run dev:api                  # terminal 1: wrangler dev (Worker + DO + local D1) on :8787
bun run dev                      # terminal 2: vite dev on :3000 (proxies /api -> :8787)
```

The app is a static SPA that talks to the Worker over `/api/*`, so both servers must run. Testing the OAuth-gated `/mcp` endpoint locally needs `BETTER_AUTH_URL` + `BETTER_AUTH_TRUSTED_ORIGINS` in `.dev.vars` (the `wrangler dev` custom-domain simulation rewrites both the issuer and the request `Origin` to the prod domain) — see `.dev.vars.example` and [ADR 0026](./docs/adr/0026-agent-native-mcp-server.md).

## Error Handling

**Effect replaced errore** ([ADR 0012](./docs/adr/0012-effect-replaces-errore.md)). Effect's typed-error channel is the error model; the errore.org library is fully removed from `src/` and dropped from `package.json`. Don't reintroduce it. The value-as-error pattern (return `Error | T`, check `instanceof Error`) still appears where it fits (e.g. `bootstrapOutline`), but the error type is now an Effect `Data.TaggedError`, not an errore class. See `kv-client-effect.ts` for the Effect v4 patterns in use (`Data.TaggedError` tagged errors, `Schedule.both` retry, `Effect.timeoutOrElse`); the Worker (`worker/index.ts`) is already a full Effect pipeline.

The Effect transport **core** for the kv side-collections is `src/data/kv-client-effect.ts` (retry + 8s timeout + typed errors + response-shape validation). Two shells consume it:

- **`src/data/kv-api.ts` is a throw-shell over the core.** `kvFetch`/`kvPut`/`kvDelete` run the matching Effect program through `runPromise`, so every kv write inherits the core's robustness. They MUST keep throwing — TanStack DB mutation handlers signal failure by throwing (a throw triggers optimistic rollback), so consumers need a rejecting promise, not an Effect value — but the throw is now Effect-backed, not bespoke fetch. Keep them throwing; don't reintroduce a hand-rolled fetch.
- **`claimMapping` (daily-index.ts) consumes the Effect program directly.** It has no TanStack caller (an awaitable from a click handler), so it routes `kvGetOrCreateE` through `Effect.match` and degrades to a plain value at its own boundary (the daily-note feature keeps working on failure).

**The Worker→DO trust boundary is validated and atomic** ([ADR 0014](./docs/adr/0014-validate-the-worker-do-trust-boundary.md)). Two coordinated fixes, right tool per layer:

- **Input validation = Effect Schema, Worker-side.** Every `/api/nodes` + `/api/kv` body is decoded against a request-body schema in `worker/wire.ts` (via `decodeBody` in `worker/index.ts`); a malformed body fails into a typed `BadRequest` → one `catchTag` → **400**, instead of dereferencing `undefined` deep in the DO's SQLite loop (a 500 from storage). The `Node`/`ChangeOp`/`ServerMessage` wire types are **derived** from Effect Schemas (`Schema.Schema.Type<…>`) — the validator *is* the type, so they can't drift. Those wire schemas live in **one shared leaf, `src/data/wire-schema.ts`** (imports only `effect/Schema`, no DOM/workers types), imported by **both** the client (`src/data/realtime.ts`, whose `decodeFrame` now decodes inbound sync frames against `ServerMessageSchema` — closing the last unchecked inbound cast, ADR 0013) **and** the Worker (`worker/wire.ts` + `worker/outline-do.ts`), so the client decoder and the DO broadcaster can't drift across the two tsconfigs. `worker/wire.ts` keeps the request-body wrappers (`NodesPostBody`, …) local; the client's domain node schema (`src/data/schema.ts` `nodeSchema`) is a field-for-field mirror kept in parity. Don't reintroduce unchecked `as` casts on request bodies or inbound frames; don't add Schema `.default()`s that paper over a bad body.
- **Write atomicity = CF-native `transactionSync`, DO-side (NOT Effect).** Each node mutation in `outline-do.ts` (`applyBatch`/`upsertNodes`/`patchNodes`/`deleteNodes`) wraps its SQL — row writes **and** seq bump + changelog — in one `ctx.storage.transactionSync()`, so a mid-loop throw rolls the whole batch back; `commitChange` was split into `recordChange` (SQL, inside the transaction) + `broadcastChange` (after commit), so a frame is emitted only on durable commit. The DO is not an Effect program and atomicity is a storage concern — don't pull Effect's runtime into the DO for this. kv writes (`upsertKv`/`deleteKv`) are intentionally NOT wrapped yet (no changelog/broadcast → can't tear the sync stream).

## Documentation Freshness

Repo reality is the source of truth. If `AGENTS.md` or `README.md` becomes false about an objective fact (repo structure, paths, commands, tooling, workflow constraints proven by the repo), fix it in the same change.

- Update `AGENTS.md` for stale agent-facing facts, `README.md` for stale human-facing purpose/install/use; update both if both are stale (don't make them mirror each other).
- Ask before changing policy, philosophy, positioning, or workflow intent.
- Ignore temporary/generated/local-only/unrelated untracked files; ask before broadening scope to unrelated user changes.
- After repo-reality changes, re-check both docs and mention any freshness updates in your final response.

## Planning and design

Substantial plans or design decisions go through `/grill-with-docs` — a relentless interview that *sharpens* the decision, recording docs (ADRs, and a glossary if one is warranted) via `/domain-modeling` as they crystallise.

- A decision earns an **ADR** in [`docs/adr/`](./docs/adr/) when it is hard to reverse, surprising without context, and the result of a real trade-off — the bar and the file shape are in the `domain-modeling` skill's `ADR-FORMAT.md`. ADRs are numbered sequentially (`0001-slug.md`); the dotflowy set captures the calls an agent would get wrong from the code alone (the per-node tree store, atomic structural writes, the per-user DO, and so on).
- If the code already makes the call obvious, the code is the doc — don't write it down.
- When a decision changes, edit its ADR in place (or mark it superseded). History — including superseded decisions and their rejected alternatives — is in `git log`.

## Commands

```sh
bun run dev        # vite dev on :3000 (or next free port)
bun run build      # production build (also prerenders /)
bun run lint       # oxlint over src + worker (correctness = error)
bun run lint:fix   # oxlint --fix (autofixable rules only)
bun run typecheck  # tsc --noEmit
bun run typecheck:test  # tsc over the unit tests (tsconfig.test.json)
bun run test       # bun test over src + worker/ (pure-logic unit tests)
bun run test:e2e   # playwright (chromium) end-to-end tests
bun run test:e2e:ui  # same, in Playwright's interactive UI
bun run build:cf   # vite build + copy _shell.html -> index.html (Cloudflare)
bun run cf:dev     # watch loop (scripts/cf-dev.ts): build:cf + wrangler dev, rebuilds on src/ changes
bun run deploy     # build:cf, then `wrangler deploy`
bun run repos:update-effect  # pull latest Effect v4 source into repos/effect-smol (git subtree)
npx -y react-doctor@latest . --verbose  # React health scan; tuned via doctor.config.json
```

## Vendored Repositories

This project vendors external repositories under `repos/` to give agents direct source access.

**Rules:**
- Treat `repos/` as **read-only reference material** — never edit files there unless explicitly asked.
- **Do not import from `repos/`** — application code imports from normal package dependencies (`effect`, etc.).
- Prefer examples and patterns from vendored source over guesses or web search.
- Do not add `repos/` paths to `tsconfig.json` includes — they are excluded intentionally.

### `repos/effect-smol` — Effect v4 source

Effect v4 is **post-training-cutoff** for most models. Always consult this subtree when writing Effect code.

1. **Read `repos/effect-smol/AGENTS.md` and `repos/effect-smol/LLMS.md` first** — the Effect team's agent instructions for the repo.
2. **Explore `repos/effect-smol/packages/effect/src/`** for idiomatic patterns, module structure, and API signatures.
3. **Check tests** in `repos/effect-smol/packages/effect/test/` to see how APIs are exercised in practice.
4. Treat `repos/effect-smol` as the source of truth for Effect v4 — supersedes any pre-training knowledge of Effect v3.

To update: `bun run repos:update-effect`

**Unit tests run on `bun test`** (`bun run test` = `bun test src worker/`, scoped so it never grabs the Playwright `e2e/*.spec.ts` — and the trailing slash on `worker/` keeps it from matching the vendored `repos/.../workers/` tests), co-located as `src/**/*.test.ts` and `worker/**/*.test.ts`. They cover **pure logic only** (`tags.ts`, `links.ts`, `tree.ts`, and other side-effect-free modules) — **behavior/integration stays Playwright** (don't unit-test the contentEditable/caret/collection/DO path; you'd only end up mocking the world). Two principled exceptions: (1) the **sync socket's reconnect/handshake policy** (`realtime.test.ts`), because Effect's `WebSocketConstructor` is an injectable service — a fake socket is one clean seam, not mocking the world ([ADR 0013](./docs/adr/0013-sync-socket-as-an-effect-resource.md)); and (2) the **Worker trust-boundary schemas** (`worker/wire.test.ts`), because request-body decode is pure (valid bodies decode, malformed reject) and e2e can't reach it — `seedOutline` mocks the Worker, so the real `worker/index.ts` decode path never runs ([ADR 0014](./docs/adr/0014-validate-the-worker-do-trust-boundary.md)). For `Node`/`TreeIndex` fixtures use `makeNode()` from `tree.ts`, the canonical partial-node builder — not ad-hoc casts. Test files are **excluded from the app `tsconfig.json`** (and from `worker/tsconfig.json`) so `bun:test` and Bun globals never leak into the browser/Worker typecheck, and are checked on their own via **`typecheck:test`** (`tsconfig.test.json`, `types: ["bun"]`, now also covering `worker/**/*.test.ts`), mirroring `typecheck:worker`. Plus the two static gates: **`oxlint`** (`.oxlintrc.json`, VoidZero's Oxc linter — `correctness` category as errors, `react` plugin on; scoped to `src` + `worker`, mirroring `typecheck`'s boundary, with `src/routeTree.gen.ts` ignored) and **`typecheck`** — run them all after any change. `oxlint` is lint-only by choice (no formatter); `jsx-a11y` is off for now because the contentEditable/click-handler-heavy editor would false-positive on day one (easy opt-in later). End-to-end behavior is **Playwright** (`e2e/`, chromium-only, dev server on port 3210, reuses a running one). Specs seed via `seedOutline` (`e2e/fixtures.ts`), which **`page.route`-intercepts `/api/nodes`** (and `/api/kv`) with an in-memory `Map` mock of the Worker (GET all / POST upsert `{nodes}` **or** atomic batch `{ops}`→`{seq}` / PATCH `{updates}` / DELETE `{ids}`/`{keys}`) **and is realtime-faithful**: every write bumps a `seq` and echoes a `{type:'change',seq,ops}` frame over the `/api/sync` WebSocket mock — so the real `collection.ts`/`api.ts`/`kv-api.ts` path runs against a Map, no `wrangler dev` needed. `seedOutline(page, nodes, { echoDelayMs, postDelayMs })` can delay the echo (`echoDelayMs`, to reproduce the optimistic-overlay/echo gap — the structural batch path holds its overlay across it) or the batch POST *response* (`postDelayMs`, to prove rapid batches serialize on the wire and can't reach the DO out of order) — both in `atomic-structural-writes.spec.ts`. The store is per-`page`, so `fullyParallel` tests never share state. `e2e/` is outside `tsconfig.json`'s `include`, so it doesn't affect `typecheck`.

**Caret in a contentEditable test:** don't use `Home`/`End`/arrow keys (unreliable in macOS Chromium contentEditable) and don't rely on `.click()` (lands *past* the bullet text — the `.node-text` span is wider than its text). Set the Selection range directly via `evaluate` (see the `caretAt` helper in `e2e/enter-split.spec.ts`). `toHaveText` normalizes whitespace — prefer space-free fixture text (`"alphabravo"`) or `allTextContents()` for exact comparison.

## Generated files

`src/routeTree.gen.ts` is **auto-generated** by the TanStack Start Vite plugin — never hand-edit. After adding/renaming a file in `src/routes/`, run `bun run dev` once to regenerate it, else `typecheck` fails on typed routes.

## React Compiler

**On.** `babel-plugin-react-compiler` runs over every component at build *and* dev (health-checked 137/137 compile, no incompatible libs). It auto-memoizes, so it's **additive** to the hand-tuned `memo`/`useMemo` in the editor — don't rip those out to "let the compiler do it"; they still gate the contentEditable hot path and removing them is a behavior-risky refactor the compiler doesn't make safe.

- **One opt-out: `OutlineEditor` carries `"use no memo"`** (ADR 0019). The compiler would memoize `virtualizer.getVirtualItems()` on the stable virtualizer instance and freeze the windowed list on scroll. The shell keeps its referential stability by hand, so this costs nothing on the hot path. Don't remove it; don't add the directive elsewhere without the same concrete reason.

- **Wiring gotcha (Vite 8 / Rolldown).** `@vitejs/plugin-react` v6 uses the native Oxc transform, **not** Babel — there is no `viteReact({ babel })` option (it silently no-ops). The compiler runs through a separate `@rolldown/plugin-babel` plugin fed `reactCompilerPreset()`, listed **after** `viteReact()` in `vite.config.ts`. Peer deps: `@rolldown/plugin-babel`, `@babel/core`, `babel-plugin-react-compiler` (pin `@rolldown/plugin-babel` to `^0.2`; `0.1.x` has a broken `workspace:*` manifest that bun won't resolve).
- **Verifying it ran:** an unminified build (`bunx vite build --minify false`) leaves the compiler's `$[i]` cache-slot accesses readable in the editor chunk (the `_c` helper is renamed by bundling, so grep `$[` not `_c`).

## SPA mode (no SSR)

Don't run code that touches `nodesCollection` during a server/render pass. Why: [the SPA/no-SSR constraint](./docs/adr/0008-sync-via-a-per-user-durable-object.md).

## Deploying to Cloudflare (Worker + per-user Durable Objects)

**One Worker** (`worker/index.ts`) on **Cloudflare Workers** (not Pages) serves the static SPA (via `ASSETS`) and the sync API — `/api/nodes` (outline) and `/api/kv` (plugin side-collections) — **routed to a per-user Durable Object** (`UserOutlineDO`, `worker/outline-do.ts`) whose colocated SQLite holds that user's outline. D1 holds Better Auth's identity tables + the legacy import source. Design + rejected alternatives: [per-user DO sync](./docs/adr/0008-sync-via-a-per-user-durable-object.md) and [the auth gate](./docs/adr/0011-the-auth-gate.md).

- **`_shell.html` → `index.html` copy is load-bearing.** SPA mode emits `dist/client/_shell.html`, but Static Assets serves `index.html` for root + SPA fallback. `build:cf` copies it; don't point wrangler at a dir without that copy.
- **`run_worker_first: true`** routes *every* request through the Worker, but the **static shell is public** — after the two public OAuth discovery routes (`/.well-known/oauth-*`, below), the Worker short-circuits non-`/api` requests to `env.ASSETS.fetch` (SPA fallback for `/$nodeId` intact) *before* touching auth, so the login screen loads. Only `/api/*` is gated.
- **Identity = Better Auth** (`worker/auth.ts`, email + password signup, sessions in D1). **Signup is invite-gated during alpha:** a `hooks.before` on `/sign-up/email` rejects any body whose `inviteCode` isn't in the comma-separated `INVITE_CODES` secret — server-side on purpose (hiding the UI wouldn't stop a direct POST) and **fail-closed** (unset = signup off; sign-in untouched). The gate must stay server-side; signup is the only account-creation path (MCP dynamic registration creates OAuth clients, not users). The companion **`POST /api/waitlist`** is the one other PUBLIC `/api` route: per-IP rate-limited (`WAITLIST_LIMIT`), CORS'd for the landing site, inserting normalized emails into the D1 `waitlist` table (migration `0005`; duplicate = silent ok, non-enumerable). **`GET /api/waitlist` is the ADMIN view** behind the `ADMIN_EMAILS` allowlist (a `wrangler.jsonc` var; fail-closed) — non-admins get the same 404 as a missing route, and the unlinked `/admin/waitlist` page (`src/routes/admin.waitlist.tsx`) is just its renderer. `createAuth(env, requestOrigin)` is built **per request** (the D1 binding only exists in `fetch` — never a module singleton; the origin backs the OAuth issuer when `BETTER_AUTH_URL` is unset). `/api/auth/*` → `auth.handler`; `/api/nodes` + `/api/kv` require `auth.api.getSession` (401 otherwise). The client gates the editor behind `useSession()` (root `AuthGate` in `__root.tsx`). Better Auth needs `node:crypto`, hence `compatibility_flags: ["nodejs_compat"]`. **Never relax the `/api` session check to trust a client-supplied id.**
- **`POST /mcp` is the MCP endpoint** (with `/api/mcp` kept as a working alias) ([ADR 0026](./docs/adr/0026-agent-native-mcp-server.md)): a **stateless** Streamable-HTTP JSON-RPC server (hand-rolled Effect pipeline in `worker/mcp.ts` — don't swap in `McpServer.layerHttp` or the official SDK's stateful mode, their in-memory sessions die across Worker isolates). `/mcp` is the ecosystem-default path clients probe, so `worker/index.ts` routes it before the assets shortcut and through the same token gate. Auth is an **OAuth 2.1 bearer token** (Better Auth `mcp` plugin: authorize/token/dynamic-registration under `/api/auth/mcp/*`, tokens in D1, discovery at `/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource` — matched by PREFIX so RFC 9728 path-aware probes like `/.well-known/oauth-protected-resource/mcp` resolve too), validated via `auth.api.getMcpSession` — the token's `userId` routes through the same `resolveUserId` to the same per-user DO as a browser session. Tools live in `worker/mcp-tools.ts` (Effect Schema inputs; `tools/list` publishes `Schema.toJsonSchemaDocument` of the same schemas that gate `tools/call`); writes are planned purely in `worker/outline-ops.ts` (imports the client's own `src/data/tree.ts` helpers so semantics can't drift) and land as ONE DO `applyBatch` frame, so live editors see agent edits in real time. The daily-note tools claim ids through the DO's atomic `getOrCreateKv` (the client's `claimMapping` twin); the daily container's protection (no delete/blank/to-do/complete) is enforced server-side. The SPA `AuthScreen` doubles as the OAuth login page (it resumes `/api/auth/mcp/authorize` after sign-in when OAuth params are in the URL).
- **`GET /api/unfurl?url=` fetches a pasted URL's title** ([ADR 0016](./docs/adr/0016-link-title-unfurl.md)), session-gated like the rest and DO-independent (it runs before the stub resolves). The fetch is an authenticated SSRF surface, so it's hardened in `worker/unfurl.ts` (scheme + hostname guard, manual redirects with per-hop revalidation, no credential forwarding, 5s timeout, 64KB cap, content-type gate) with the pure guards in `worker/unfurl-core.ts`; successful titles are cached cross-user (Cache API, 24h) and the route is per-user rate-limited (the `UNFURL_LIMIT` binding in `wrangler.jsonc`). Returns `{title: string|null}` — 400 only for a missing/non-http(s) `url`, else 200 (`null` = "no title"). **Don't relax the SSRF guard or follow redirects without re-validating each hop.**
- **The DO routing key is the session's `user.id`.** `resolveUserId(sessionUserId, env)` (in `worker/index.ts`) picks the caller's Durable Object. **Never key the DO off the email:** a DO name is permanent, so that would orphan a user's whole outline on any email change. The one exception is the **owner-continuity bridge** — set `OWNER_USER_ID` to the owner's `user.id` and that single account maps to the constant `'default'` DO (where the pre-auth outline lives), zero copy. `ensureSeeded` (legacy D1 import) runs **only** for the `'default'` DO; new users start empty.
- **The Worker is typechecked separately** (`bun run typecheck:worker`, `worker/tsconfig.json` with `@cloudflare/workers-types`); it lives in `worker/` so its runtime types don't clash with the app's DOM lib. Don't move it under `src/`.
- **Dev loop:** copy `.dev.vars.example` → `.dev.vars` and set `BETTER_AUTH_SECRET` (the Worker fails closed without it); run `bun run dev` (Vite) *and* `bun run dev:api` (`wrangler dev` on :8787, Worker + the DO + local D1); first time `bun run db:migrate:local`. `bun run cf:dev` is a production-like single-server preview. In prod set the secret with `wrangler secret put BETTER_AUTH_SECRET`.
- **Migrations:** the SQL files in `migrations/` (`bun run db:migrate:local` / `:remote`, run `:remote` **before** the first `bun run deploy`) are **D1** migrations — `0001`/`0002` (legacy nodes/kv = DO import source), `0003` (Better Auth tables, generated verbatim from `better-auth` `getMigrations()`; re-generate if auth options change), and `0004` (the `mcp` plugin's OAuth tables, written from its oidc-provider schema in `0003`'s conventions). The DO's own schema is created in its constructor (no SQL file); it's registered via the `new_sqlite_classes` tag in `wrangler.jsonc`.
- **The SPA/no-SSR rule still holds:** the React app stays a pure static SPA; the per-user DO holds the data and the Worker routes `/api/*` to it, never the render pass.

## Data layer gotchas

- **Nodes live in a per-user Durable Object's SQLite** ([per-user DO sync](./docs/adr/0008-sync-via-a-per-user-durable-object.md)). `nodesCollection` is a TanStack DB *custom sync* collection over `/api/sync` (`collection.ts` + `realtime.ts`); **field** writes PATCH `/api/nodes` (`api.ts`), **structural** writes go through `runStructural` as one atomic batch POST `{ops}` (see the next bullet). The socket is an **Effect scoped resource** ([ADR 0013](./docs/adr/0013-sync-socket-as-an-effect-resource.md)): `realtime.ts`'s `makeSyncStream` is a pure `Stream<SyncEvent>` producer (`Socket.makeWebSocket` + a backoff loop + reset-after-stable), and `collection.ts` forks **one long-lived fiber** on the shared `appRuntime` (`runtime.ts`) to fold it into the sync primitives. Don't reintroduce a callback socket. The echo waiters are Effect too: `waitForSeqE`/`waitForNodeE` (`collection.ts`) lift the registration with `Effect.callback` (resolve-on-timeout vs fail-on-timeout), and `runStructural` composes the batch send + echo-hold as ONE Effect bridged at its `mutationFn`; only the daily loser-path keeps a thin `waitForNode` Promise wrapper. The cursor (`appliedSeq`) is still a plain module value with callback resolves. **Side-collections (`tag-colors.ts`, `daily-index.ts`) ride the same DO** as query collections over `/api/kv?collection=<name>` (`kv-api.ts` + `query-client.ts`); each passes its **concrete** Effect `Schema` inline (wrapped with `Schema.toStandardSchemaV1`, which TanStack DB consumes as a StandardSchema; a generic factory loses schema inference). The old `dotflowy-oss:*` localStorage keys are no longer read.
- **Structural edits are atomic; field edits are direct.** Any tree-shape mutation (insert/indent/outdent/move/reparent/remove, undo/redo restore, daily get-or-create) MUST be wrapped in `runStructural` (`structural.ts`) so all its `nodesCollection` writes land as ONE batch (`POST /api/nodes {ops}` → DO `applyBatch` → one frame) AND the optimistic overlay is held until that frame's echo (`waitForSeq`) — both are load-bearing; removing either reintroduces the sibling-chain corruption. **Field edits** (`setText`, `toggleCompleted/Collapsed`, `setIsTask`, `toggleBookmark`) stay direct — single-field PATCH, already atomic, and the keystroke path must NOT await an echo. Wrap at the editor `commands`/history/plugin call sites, not inside `mutations.ts` (keeps it pure; `runStructural` self-guards nesting). Why: [Atomic structural writes](./docs/adr/0009-atomic-structural-writes.md).
- **First-run bootstrap = seed-if-empty.** On mount `OutlineEditor` calls `bootstrapOutline()` (`seed.ts`), which seeds the welcome bullets only when the outline is genuinely empty (a brand-new account). **There is no client-side data migration:** the old localStorage import was removed because localStorage is browser-scoped but accounts are per-user, so it leaked one browser's leftover outline into every new account that signed in there. A returning owner's pre-DO data is carried over **server-side** instead — the Worker does a one-time non-destructive copy of any pre-DO **D1** rows into the owner's DO on first `/api/sync` connect (`ensureSeeded`), and the DO marks itself `seeded` and never re-imports.
- **e2e seeds through the API, not localStorage** (`seedOutline` mocks `/api/nodes` and `/api/sync`). Don't reintroduce a localStorage node seed for the live store.
- **Build nodes via `makeNode()` in `tree.ts`** — don't add defaulted/optional fields to `schema.ts` (the schema is Effect `Schema`, no longer zod, but the no-defaults rule stands: a default makes the field optional in the encoded type and fights TanStack DB's schema-typed collection overload). Why: [No schema defaults](./docs/adr/0003-no-schema-defaults.md).
- **Mutations operate on the live `TreeIndex`.** Every `mutations.ts` function takes the current index and mutates `nodesCollection` directly. The `useMemo`-stable `commands` object reads live values at **event time** through module getters — `getTreeIndex()` for the tree, `getViewRootId()`/`getViewIsHidden()` for view state — never this render's values, which is what keeps `commands` referentially stable. [Tree store](./docs/adr/0004-localized-rendering-via-the-tree-store.md).
- **Per-node subscriptions, not a threaded index.** Components read the **tree store** (`tree-store.ts`): `useNode(id)`, `useVisibleChildIds(parentId, showCompleted)`, `useVisibleRows(rootId, isHidden, filter)` (the windowed render driver), `useTreeIndex()`. The live row (`OutlineRow`, default windowed path — see *Virtualized rendering*) and the flag-off `OutlineNode` each take a `nodeId` and read their own slice, so a keystroke re-renders only the changed bullet. **Don't pass `node`/`index` as props to a row.** [Tree store](./docs/adr/0004-localized-rendering-via-the-tree-store.md).
- **Ephemeral view state mirrors the tree store.** `view-state.ts` mirrors `tree-store.ts` for the zoom root + visibility prune (`getViewRootId()`/`getViewIsHidden()`): **render reads use the `rootId` prop / `isHidden` memo directly; event-time reads (drag, commands, zoom, hotkeys) use the getters — never the reverse.** Writes happen in `useSyncViewState`'s effect, not during render, so the editor stays React-Compiler-eligible (no ref-during-render bailout). [Tree store](./docs/adr/0004-localized-rendering-via-the-tree-store.md).

## Styling

Inline Tailwind classes, not a separate CSS file (separate CSS only for the view-transition rules in `styles.css`).

## Editor internals (OutlineEditor + OutlineNode)

- **`OutlineNode` = a `memo`'d wrapper + `OutlineNodeBody`.** The wrapper calls `useNode(nodeId)` and early-returns when the node is gone; keep all other hooks in the body (rules-of-hooks). The memo only pays off while `commands`/`registerRef`/`pivotId`/`showCompleted` stay referentially stable — never pass a fresh object/callback per render. [Tree store](./docs/adr/0004-localized-rendering-via-the-tree-store.md).
- **contentEditable text sync is manual.** The `node-text`/title spans are contentEditable, not controlled React. Stored text is written to the DOM only when it differs (to avoid clobbering the caret); `onInput` pushes to the store. Don't convert to React-controlled text.
- **The `refs` registry maps node id → contentEditable span.** List bullets register under their own id; the zoomed **title registers under `rootId`**. So `refs.current.get(id)` works whether that node is a title or a list item — focus, pending-focus, and the zoom morph all rely on this.
- **A node renders in TWO paths — keep node-decorations mirrored.** The same node is a list bullet in `OutlineNode` *and* the zoomed page title in `OutlineEditor`'s `ZoomedTitle`. Plugin **node slots** (Seam F) cover both via mirrored positions — `slotsAt("row:before-text")` in the bullet, `slotsAt("title:before-text")` in the title, slots rendered **before the lock** in each (plus the mirrored `*:after-text` trailing zone) — so the daily badge / todos checkbox show in both. This duality is why a row-only decoration silently goes missing when a node is zoomed; if you add chrome to one path, ask whether the other needs it too.
- **Enter splits the bullet at the caret.** Text left of the caret stays; text right moves to a new sibling below, focused at its *start* (the lone exception to the end-of-text `pendingFocus` default — `pendingFocusAtStart`). Caret-at-end is the empty-tail case, so Enter at the end of an expanded parent still dives in. One undo step. `e2e/enter-split.spec.ts`.
- **Keyboard expand/collapse is directional, not a toggle:** `Cmd+↓` opens a closed bullet, `Cmd+↑` closes an open one, everything else is a silent no-op; both always `preventDefault`, one level, focus stays.
- **Arrow Up/Down crosses bullets from the edge *visual line*, preserving the caret column** (rect comparison, not text offset; lands via `caretPositionFromPoint`). The neighbor walk (`findVisibleNeighbor` → `flattenVisible`) **must mirror render visibility** (skip completed when `showCompleted` is off) or focus silently no-ops.
- **Cmd+Shift+↑/↓ moves a bullet among *visible* siblings; at the edge it reparents into the parent's adjacent sibling as a child** (no-op when there is no aunt/uncle, or when the node sits directly under the zoom root). `moveUp`/`moveDown` in `mutations.ts`.
- **Dragging the bullet dot reorders *and* reparents in one drop** (mouse + touch; y picks the gap, x picks depth). Lives in `use-drag-reorder.ts`, runs imperatively on the hot path. The dot still zooms on a plain click (a movement threshold + `consumeClick()` split drag from click).
- **A moved bullet flashes then fades** (`flash-node.ts`, `.outline-row.node-acted`) as an acted-upon signifier — every keyboard/drag move sets `pendingFlash` alongside `pendingFocus`; `/move`'s "Go" flashes across a navigation via `requestFlashAfterNav`/`consumeFlashAfterNav`. **Expand/collapse also flashes the toggled row** (fired directly in `onToggleCollapsed`, the single funnel for the chevron + `Cmd+↑/↓`) to compensate for the reveal animation ADR 0019 dropped. `e2e/move-flash.spec.ts`, `e2e/collapse-flash.spec.ts`. The sibling **`rejectRow`** (`.outline-row.node-rejected`) shakes a row side-to-side when a *rejected* action lands on it (a protected node's blocked delete/blank/to-do/complete — see [ADR 0015](./docs/adr/0015-protected-nodes.md)) — same one-shot-class mechanic, with a destructive-tint pulse fallback under `prefers-reduced-motion`. `e2e/daily-notes.spec.ts`.

## Mobile actions bar (ADR 0030)

A mobile-only, keyboard-anchored action strip ([ADR 0030](./docs/adr/0030-mobile-actions-bar.md)) — `MobileActionsBar` (`MobileActionsBar.tsx`), mounted once inside `OutlineEditor` behind `isMobileBar()` (`flags.ts`, localStorage `dotflowy:flag:mobile-bar`, default ON; deleted after dogfooding like `isVirtualized`). Six buttons: `[outdent][indent] | [undo][redo] | [complete][/]`. Three **orthogonal** signals drive it, kept separate on purpose: **presence = pointer type** (`matchMedia("(pointer: coarse)")`, so it never mounts on desktop — same seam as ADR 0029), **visibility = focus** (shown only while an outline contentEditable span is focused — `findFocusedId()` non-null is the "editing" probe, which also guarantees every button has a target), **position = `window.visualViewport`** (`useKeyboardViewport`, rAF-throttled, translates the bar above the software keyboard; falls back to `bottom:0` + `env(safe-area-inset-bottom)`). Deliberately **not** `env(keyboard-inset-*)` (Chromium-only; iOS needs the JS path anyway).

- **It blends with iOS's keyboard accessory bar, which the web CAN'T remove** (no Safari API for `inputAccessoryView`; standalone/PWA doesn't change it). So the bar is a **floating frosted-glass capsule** (inset, big radius, translucent + blurred, soft shadow) that adopts the accessory pill's shape *grammar* — our app-action tier reads as a sibling above iOS's system tier, not a second bar fighting it. Match the **family, not iOS's exact tokens** (they drift per OS version). Two de-dups: **no dismiss button** (iOS "Done" / Android back already dismiss the keyboard) and **complete is a boxed check (`SquareCheck`), not a bare ✓** so it can't be mistaken for the "Done" check below it.
- **The bar is dumb chrome over a facade.** `useMobileBarActions` (in `OutlineEditor`) re-exposes the existing `commands` (`useNodeCommands`) + `undo`/`redo` as zero-arg methods, each resolving `findFocusedId()` internally — so the bar inherits `runStructural` atomicity, protected-node guards, and undo coalescing for free; it adds **no new mutation path**. Buttons are static/always-enabled (no per-node subscription — the ADR 0014 budget); invalid actions safely no-op and feedback lives at the row (strikethrough, `.node-acted` flash, `rejectRow` shake).
- **Every button `preventDefault`s on `onPointerDown`** to keep the caret/keyboard alive across the tap (no exceptions — there is no dismiss button).
- **The `/` button inserts a literal `/` via `document.execCommand("insertText", false, "/")`**, faithfully simulating the keystroke so the row's own `detectSlash`/`useSlashMenu` opens the palette (insert-and-open, **not** a toggle). Don't hand-splice the DOM — the native input event is what the row's source-offset handler reads.
- **Not e2e-testable → manual iPhone checklist in the PR:** keyboard positioning, `visualViewport` tracking, iOS focus-preservation under `preventDefault`, and how the glass capsule reads stacked above the iOS accessory pill. `e2e/mobile-actions-bar.spec.ts` covers coarse-only mount, focus/blur visibility, and each button's wiring.

## Virtualized rendering (ADR 0019)

**The outline renders as a flat, windowed list by default** ([ADR 0019](./docs/adr/0019-virtualized-outline-rendering.md)) — NOT the recursive `OutlineNode → OutlineNodeChildren` tree. That recursive path still exists but only behind `isVirtualized()` returning false (`src/data/flags.ts`, localStorage `dotflowy:flag:virtualized` = `off`); it's the rollback fallback, to be **deleted** once dogfooded. When you touch the live editor, you're touching the windowed path.

- **`OutlineRow` (`OutlineRow.tsx`) is the live row**, not `OutlineNode`. It's a leaf (no children recursion); nesting is `depth`-driven `paddingInlineStart`, not DOM structure. The row IS the absolutely-positioned, `measureElement`-measured `<li>` (carries the `translateY(start - scrollMargin)` transform + `data-index`), so it stays an `<li[data-node-id]>` directly under the list `<ul>` (CSS + e2e selectors rely on that). **It re-renders on scroll to reposition — expected.** It claims `pendingFocus`/`pendingFlash` in its own mount layout-effect (a scroll-driven mount isn't a tree change `FocusPass` can see). During the flag window, keep `OutlineRow` and `OutlineNode` in lockstep (the row markup is duplicated on purpose so the recursive baseline stays untouched for parity).
- **The flat list is `useVisibleRows(rootId, isHidden, filter)` (`tree-store.ts`)** → `buildVisibleRows` (`visible-order.ts`) → `{id, depth, ancestorCompleted}[]`. It rebuilds **only** when `structureRev` changes (structural edit OR collapse/completed flip); a plain keystroke is an O(1) rev compare, so the windowed list never re-flattens on typing.
- **`OutlineEditor` opts out of React Compiler (`"use no memo"`).** The compiler memoizes `virtualizer.getVirtualItems()` on the stable virtualizer instance and freezes the window on scroll. Don't remove the directive. The shell's hand-tuned `useMemo`/`useCallback` keep row props stable regardless, so the typing hot path is unaffected.
- **Off-screen focus + drag** go through `src/data/virtual-nav.ts`: `scrollRowIntoView(id)` scrolls an unmounted target in (then the row claims focus on mount); `virtualRowRect(id)` gives the drag its hit-test geometry from the virtualizer measurements, not the DOM. `use-drag-reorder.ts` branches on `isVirtualNavActive()`.
- **`data-parent-id` (absent = top-level) + `data-depth`** on each row expose the real parent/depth; assert nesting via those, never DOM containment (`li[parent] li[child]` is gone). Windowing proof: `e2e/virtualized-windowing.spec.ts`.
- **Collapse/expand is instant** (the flat list drops collapsed descendants, so the grid-rows slide can't survive); the toggled row flashes (`.node-acted`, via `onToggleCollapsed`) to replace that lost reveal feedback. Node-selection tints **full-width** rows. All deliberate (ADR 0019).

## Node multi-selection

A second editing mode that selects whole **nodes** (not text), so one action hits several subtrees at once ([ADR 0018](./docs/adr/0018-node-multi-selection.md)). The model is a **contiguous run of siblings under one parent** (`rootIds`); selecting a node implies its subtree. Caret and selection are **mutually exclusive** — there's no text caret while nodes are selected. State lives in `src/data/selection-state.ts` (a module singleton mirrored like `view-state.ts`, now backed by an **XState v6 machine** with Effect-Schema-typed context + events — [ADR 0020](./docs/adr/0020-node-selection-as-an-xstate-machine.md)); the runtime half (the while-selected keyboard + the actions menu) is `src/components/selection-mode.tsx`. The machine's public API is frozen, so the swap is internal; reads go through `@xstate/react`'s `useSelector` on a module-singleton actor (never `useMachine`).

- **Per-node read, never a prop.** Each row subscribes to its own slab via **`useSelectionEdge(id)`** (shape of `useIsProtected`), so a selection change re-renders only the rows entering/leaving it — the ADR 0014 budget. **Don't thread selection as a prop.** Only selected ROOTS carry a `data-selected` edge (`top`/`bottom`/`middle`/`single`); the root's `<li>` background tints its whole subtree, and contiguous roots merge into one slab (`margin:0`). Visual lives in `styles.css` (`.outline-node[data-selected]`).
- **Enter:** `Shift+↑/↓` from a focused bullet (the **first press selects only the focused node** — direction-agnostic entry, same as `Cmd+A` rung 2; **subsequent** presses are the anchor/focus walk: shrinks-toward-anchor then extends; at the sibling boundary a **multi-root** run no-ops, while a **single-root** selection walks by depth — ↑ to the parent, ↓ into the first visible child, stopping at the zoom root) and the `Cmd+A` ladder — rung 1 text (native), rung 2 this node+subtree, rung 3 whole view; the rung is **derived from the current selection state, not a press counter**. Rungs 1→2 are in `use-bullet-keymap.ts`; rung 3 + the while-selected keys (plain `↑/↓` exit to caret, `Tab`/`Shift+Tab` indent/outdent the run, `Escape`, printable **no-op**, `Cmd+C` copy, `Backspace`/`Delete`) are a capture-phase `window` listener in `selection-mode.tsx` (no caret is focused in selection mode). Selection uses the free **`Shift+arrow`** / **`Mod+A`** — `Cmd+↑/↓` (expand) and `Cmd+Shift+↑/↓` (move) are taken.
- **Exclusivity is enforced** by clearing the selection on any bullet/title `onFocus` and on a `window` mousedown outside the actions menu (`[role="listbox"]`).
- **Actions menu** (`SelectionActionsMenu`, reuses `SlashMenuList`) auto-appears anchored to the selection's **top row** — anchored via `document.querySelector` on `data-node-id`, NOT the refs Map (the bullet span's inline-arrow ref re-attaches each commit and can race a layout-effect read). It lists core **Copy** + **Move** + **Delete** plus every plugin command that opts into **`CommandSpec.runMany?(rootIds, ctx)`** (Seam C extension; `registry.selectionCommandSpecs`). `runMany` is implemented for **Move** (core, multi-target move dialog), **todos To-do** (batch `setIsTask`), and **daily Send to Today** (one batch + one nav). A single-node `run` can't be looped (Move opens N dialogs, daily navigates N times), so a command **opts in** and declares how it batches.
- **Every multi-node mutation is ONE `runStructural` batch** (ADR 0009). Delete = `removeManyNodes`, Move/Send-to-Today = `moveManyNodes`, Tab/Shift+Tab = `indentManyNodes`/`outdentManyNodes` (`mutations.ts`) — all **rebuild the index from the live collection between each `removeNode`/`moveNode`**, because looping over a stale snapshot tears the sibling chain when the operated nodes are siblings of each other. Indent/outdent **keep the selection** (`refreshSelection` re-derives the run's new parent from the live collection, synchronously inside the batch). Copy reuses `outlineToMarkdown` (ADR 0017) over the roots. `e2e/node-multi-select.spec.ts`.

## Zoom + view transitions

Clicking a bullet zooms it to a temporary root. Two rules:
- **The dot zooms (click) and drags (press + move); collapse/expand is the chevron** — in the **left gutter** (hover-reveal) on a fine pointer, relocated to the row's **right edge** on `@media (pointer: coarse)` (Workflowy-mobile parity, CSS-only, ADR 0029). Don't move zoom onto the collapse control.
- **`rootId` is route-owned** (`routes/index.tsx` → `null`, `routes/$nodeId.tsx` → `nodeId`); don't add editor-local zoom state.

It's URL-driven via the route; the pivot morphs with a `view-transition-name`. Screenshots can't verify view transitions — see *Verifying UI changes* below.

## Bookmarks

A bookmark is a **saved zoom view**, stored as `bookmarkedAt: number | null` on the node (delete the node, the bookmark goes with it). The header **star** (`BookmarkStar`, `bookmarks.tsx`) pins the current zoom root; **browsing** them lives in the Cmd+K switcher's empty state (the standalone popover was removed). **No sidebar** — the unused `ui/sidebar.tsx` is the documented promotion path. A new persistent `Node` field that needs values on existing rows can be backfilled at snapshot load in `collection.ts` (see `healSiblingChains`, which normalizes persisted data there).

## Node quick-switcher (Cmd+K search)

**Cmd+K** (or the header magnifier on touch) opens a Fuse.js fuzzy jump over every node's text, navigating to the picked node's zoom view; it also renders **plugin-contributed virtual actions** (Seam J). The whole feature is `node-switcher.tsx`, mounted **once in `__root.tsx`** and reached via `openNodeSwitcher()`. The listener is **capture-phase** (fires inside a contentEditable); cmdk's own filter is **off** (Fuse drives the list, with a second non-highlighted `aliases` key). Empty query lists bookmarks; a matching query also shows an "Actions" group. **No `Node` field, no migration.**

## Plugins (`src/plugins`)

The editor is a clean core extended by **plugins** — modules compiled into the bundle (an internal registry, *not* runtime-loaded), one per `src/plugins/<name>/`. `code`, `links`, `tags`, `todos`, `daily`, and `route-bible` are themselves plugins (dogfooded), so the core carries no feature-specific branches. Design rationale: [Plugin architecture](./docs/adr/0001-plugin-architecture.md); React-widget token mode: [React token widgets](./docs/adr/0006-react-token-widgets.md).

- **`types.ts`** — the typed contract (`definePlugin`, `El`/`WidgetEl`, `TokenSpec`, `InteractionSpec`, `CommandSpec`, `KeymapSpec`, `SlotSpec`, `HeaderSlotSpec`, `SubheaderSlotSpec`, `NodeProtection`, `ViewTransform`, `MenuSpec`, `InputSpec`, the Seam-J `Search*` types, `PluginContext`).
- **`index.ts`** — the one explicit ordered array `plugins = [code, links, routeBible, tags, emphasis, todos, daily]`. Add a plugin = add a folder + one line. Array order is the precedence tiebreak and dispatch order.
- **`registry.ts`** — derives everything from that array once at load (token regex + dispatch, interaction dispatch, view-transform composition, menu/command/keymap lists with the load-time reserved-key guard, row/header/subheader slots, `isProtected`, the Seam-J providers, the input chain, `registerWidget`). The core consumes these and stays generic.

Seams wired today (each row: the contract, who owns it):

| Seam | What it is | Owners |
| ---- | ---------- | ------ |
| **A** inline token | regex fragment + `render → El \| WidgetEl`, composed into one `gu` regex; core owns escaping. Folding token emits a `data-src` atom (`contenteditable="false"`); React mode mounts a `<dotflowy-widget>` TSX atom. Precedence: links 0 < code 10 < route-bible 15 < tags 20 < emphasis 30-33. | code, links, tags, route-bible, emphasis |
| **B** delegated interaction | one set of content-container handlers, dispatched by `target.closest(selector)`; core has zero feature knowledge. | links, tags, route-bible |
| **C** `/` command | `CommandSpec`; the `/` list is `[...commandSpecs, ...CORE]`. `/move` stays core. | todos (`/todo`,`/bullet`), daily ("Send to Today"), emphasis (`/bold` etc.) |
| **D** keymap | `{hotkey, run}`; reserved-key denylist guarded at load. | todos (`Mod+Enter`/`Mod+D`), emphasis (`Mod+B`/`Mod+I`/`Mod+U`/`Mod+Shift+X`) |
| **E** side-collection | plugin-owned data, no `Node` field (see Tag colors, below). | tags |
| **F** node slot | `{position:"row:before-text" \| "title:before-text" \| "row:after-text" \| "title:after-text", render(node,getCtx)}`, real JSX — decorates a node in BOTH render paths: the list bullet (`row:`, `OutlineNode`) and the zoomed page title (`title:`, `OutlineEditor`'s `ZoomedTitle`). `before-text` leads the node; `after-text` is the **budgeted trailing zone** (`NodeDecorations` — ADR 0031): any component, but the core clips it to `--node-deco-budget` and a ResizeObserver-driven overflow affordance opens the detail panel, so the outline can't be crowded out. A plugin opts into any position with one spec each; `slotsAt(position)` returns the precomputed-stable array. `after-text` ships DORMANT (no consumer yet). | todos (checkbox), daily (date badge) |
| **F** header slot | `{id, render(getCtx)}`, real JSX, no node — persistent actions in the header's right cluster. | daily ("Today") |
| **F** subheader slot | `{id, render(getCtx)}`, real JSX, no node — contextual chrome below the header (collapses + animates when every slot returns null; sticks with the header). | tags (filter bar) |
| **G** view transform | per-node `hidesNode` predicate (composed into the one `isHidden`) + optional global `buildFilter`. Core no longer hardcodes `completed`. | todos (hide-completed), tags (`?q=`) |
| **H** caret menu | `MenuSpec` (`trigger` + `entries`), driven by the generic `useMenus` engine. | tags (`#`) |
| **I** input | `input.onPaste` (replacement string) + `input.autoformat` (rewrite just-typed text) + `input.afterPaste` (post-insert side effect, may write back via `ctx.mutations`). | links (paste + title unfurl), todos (`[]`) |
| **J** search providers | `searchAliases`/`searchActions`/`searchAnnotation`; ctx is the minimal `{index, goTo}`, not a `PluginContext`. | daily |
| — | **overlay host** `ctx.openOverlay(node\|null)` (self-positioning popover) + **Tier-3 panel host** `ctx.openPanel(node\|null)` (a `Sheet` slide-in with backdrop + dismiss, mounted in `OutlineEditor` — the contained home for rich UI, the node-decoration overflow target, and the only surface a future Lane-B MCP App may render into — ADR 0031); **protected nodes** `protects(id) → boolean \| NodeProtection` — the plugin only *declares which* nodes; the **core enforces all four rules** (no delete / blank / to-do / complete) in `components/protection.tsx` (`guardProtected` on the command funnels, `signalRejection` on the blur heal) with a shake (`rejectRow`) + toast. A bare `true` is enough (core supplies default copy); the descriptor is **all overrides** (`reason`, `blankReason`/`taskReason`/`completeReason`, `canonicalText`). Reactive lock `<ProtectedLock>` via `useIsProtected` (tracks async protection like the daily index). [ADR 0015](./docs/adr/0015-protected-nodes.md). | tags (picker), daily (container) |

Feature → seams: **code** A · **links** A+B+I · **route-bible** A(widget)+B · **tags** A+B+E+F(subheader)+G+H · **emphasis** A(folding)+C+D · **todos** C+D+F(row+title)+G+I · **daily** C+F(header)+F(row+title)+J+protected · **child-count** F(`row:after-text`, the trailing budgeted zone — first consumer of that seam; collapsed bullets show a hidden-child count).

**Still core-wired (deliberately, awaiting future seams):** fade-inheritance (`faded`/`ancestorCompleted`) and Backspace-on-the-checkbox demotion still read `completed`/`isTask` in `OutlineNode`; the `/` palette still runs `useSlashMenu` (only its command *list* is registry-driven).

**Constraints when touching this:** keep token `render` output byte-stable (the `decorate` cache compares strings) and allocation-light (runs per keystroke); never hand the core raw HTML (return `El`/`WidgetEl`); don't reintroduce N separate token scans. **Plugin UI comes from `src/plugins/kit.ts`** — the curated shadcn surface a Lane-A plugin may use (ADR 0031); a plugin importing `@/components/ui/*` directly is an oxlint error (`no-restricted-imports` override on `src/plugins/**`). Add a component to the kit when a plugin needs it; there is no plugin `styles` seam (style via Tailwind utilities on your `El`/JSX).

## Tag filtering + colors (`src/plugins/tags/`)

`#tags` are **parsed from `node.text`**, never stored. Each renders as a clickable chip (Seam A token); a plain click AND-s that tag into a **URL-driven filter** (`?q=#a #b`) scoped to the zoom `rootId`, re-rendering a **pruned tree** (matches + dimmed ancestor context, everything else hidden). **Filtering is render-time only — it never mutates `collapsed`.** The tags plugin owns the full filter stack: URL sync, escape-to-clear, the subheader pill bar (Seam F-subheader), the Seam-G transform (`buildTagFilter`), and chip click routing (Seam B). Pure logic in `src/data/tags.ts`. `#` autocomplete is the tags plugin's Seam-H menu. v1 is click-driven, tags-only (no free text, no `@`-mentions).

**Colors** are *chosen* per tag name (not derived) and stored in the `tagColorsCollection` side-collection (Seam E, synced via `/api/kv`, now per-user DO storage) — so they sync and apply to every instance. Painted by **one generated stylesheet** keyed on `data-tag` (`TagColorStyles`, mounted once in `__root.tsx`), so recoloring is an O(1) DOM write with **zero React re-renders**. The picker (`TagColorMenu`) opens on **right-click** (Seam-B `onContextMenu` → `ctx.openOverlay`); the generator skips unsafe tag names (no CSS injection). Why: [Custom tag colors](./docs/adr/0007-custom-tag-colors.md).

## Rich links (`src/plugins/links/`)

Markdown `[label](url)` **parsed from `node.text`** (Seam A+B+I token), the only construct that **folds**: reveal is **per-link and BRACKET-style** (Lettera/Obsidian-flavored) — when the caret is within/adjacent (source offset ∈ `[start, end]`) the link shows `[label](✎)` — the brackets AND parens are real editable text (the caret walks through them one step at a time) and only the bare url is an atom, the `✎` chip (`data-src` = the url); **the raw URL never expands into the line**. Typing between `]` and `(` breaks the token match and splits the link open into raw text. Every other link folds to a clean `<a contenteditable="false">`. At most one reveals at a time. **Editing the URL is the Edit Link popover's job** (`link-edit-popover.tsx`, two fields + Done/Cancel, deliberately no preview embed): opened from the pencil (`.link-edit-icon`) trailing a folded `<a>` or from the revealed chip (Seam B, listed before the open-in-new-tab interaction so the pencil wins dispatch); the write-back is verbatim-match-or-drop (`replaceLinkToken`, first occurrence) through `ctx.mutations.onTextChange` — a mirror row resolves to its `mirrorOf` source first.

The landmine: a focused bullet can hold **folded** links, so `el.textContent` is no longer the source. The core is **source-offset-aware** — **`readSource(el)`** (inline-code.ts) reconstructs the markdown (`data-src` for atoms — a folded `<a>` or a revealed link's url chip — `textContent` otherwise) and replaces `el.textContent` in `onInput`/paste **and the slash/tag menus** (else a `/cmd` on a folded-link line drops its url); **`getCaretOffset`/`setCaretOffset`** speak SOURCE offsets, counting an atom's `data-src-len`. **Copy/cut ride the same read** (`copySourceSelection`/`cutSourceSelection` in `paste.ts`, wired on all three contentEditables): the clipboard gets the SOURCE slice, so a copied folded link comes back as markdown, not its bare label. Reveal reflow is a `selectionchange` watcher (`watchCaretReveal`) live only while focused, plus the deferred `revealLinkAtCaret` on focus — which **re-reads the DOM at frame time** (a captured snapshot would race a synchronous cut/paste landing between focus and frame and resurrect dead text). All of this early-returns on link-free lines (the 99% case). A folded `<a>` leads with the host's favicon (Google `s2/favicons?domain={host}`, chosen for longevity; inside the anchor so a click on it opens too) and trails the edit pencil. Folded links open on click (Seam-B `window.open`); creation is hand-typed or paste (Seam-I `input.onPaste`, http(s) only, URLs percent-encoded). Pasting a link with no selection appends a trailing space so the caret lands past it and the link folds immediately (selection-wrap keeps the end-of-link caret). **Pasting a bare URL also unfurls its title** ([ADR 0016](./docs/adr/0016-link-title-unfurl.md)): `input.afterPaste` fetches the auth-gated `GET /api/unfurl?url=` (a hardened Worker fetch, `worker/unfurl.ts` + pure guards in `worker/unfurl-core.ts`), then verbatim-swaps the `[url](url)` placeholder's label to the title via `ctx.mutations.onTextChange` (a field edit, not structural — no echo-wait). While in flight the folded `<a>` wears `.link-unfurling` (favicon slot → spinner, the flash-node transient-class mechanic); a failed/blocked fetch keeps the url placeholder (the graceful fallback). Search indexes `stripLinks(node.text)`. Why: [Rich links: the source-offset caret](./docs/adr/0005-rich-links-source-offset-caret.md).

## Daily notes (`src/plugins/daily/`)

A daily note is a normal node addressed by a date; the header **Today button** navigates to today's, creating it on first use. **No `Node` field, no migration, no route.**

- **Identity is a side-collection.** `dailyIndexCollection` (`daily-index.ts`) maps a key → `nodeId`: a **local** date `YYYY-MM-DD` (use `localDateKey()`, **not** `toISOString` — day boundary is local midnight) or the `container` sentinel. Never derive a day from `node.text`.
- **Structure.** Days are children of one auto-created **"Daily" container** (a **protected node**, since `removeNode` cascades — its `protects` descriptor supplies the rejected-delete toast and the `DAILY_CONTAINER_TEXT` name that's restored if the row is blanked). New days insert at the top (newest-first). `goToDate(key, ctx)` is get-or-create, idempotent and self-healing; creation uses low-level `mutations.ts` primitives directly (not `ctx.mutations` — wrong capture/focus semantics for a navigate-away create).
- **Display.** Text is seeded to the full date ("Tuesday, June 23, 2026"); a `<Badge>` node slot (Seam F) shows a relative label (Today/Yesterday/Jun 23), driven by the mapping (always correct). Registered at **both** `row:before-text` and `title:before-text`, so it shows on the list bullet AND when the day is zoomed in as the page title. **Today** gets the primary variant + a sun icon (`data-daily-today`); a `placement: "row" | "title"` prop only swaps the baseline nudge (`mt-1` on the row; none in the flex-centered title), size held constant.
- **Seam C** "Send to Today" (labeled to avoid shadowing `/move`); **Seam J** aliases each day with its relative label, adds a "Go to Today" virtual action (create-when-absent), and a `(Today)` picker annotation. Covered by `e2e/daily-notes.spec.ts`.

## Scripture references (`src/plugins/route-bible/`)

A Bible ref in `node.text` renders as a chip opening [route.bible](https://route.bible) (Seam A widget + Seam B click — the links shape minus the fold). **No `Node` field, no migration.** Widget mode: [React token widgets](./docs/adr/0006-react-token-widgets.md).

- **Liberal regex PROPOSES, `grab-bcv` DISPOSES.** `BIBLE_REF_PATTERN` (`bible.ts`) requires a chapter, verse optional, and over-matches on purpose; `resolveBibleRef(tok)` runs the candidate through grab-bcv's `tryParsePassage` and returns null for non-references (the core then renders raw text). Dependency is **`grab-bcv`** (parse + `toResolverUrl`), not `@route-bible/core`.
- **A real-TSX atomic widget** ([React token widgets](./docs/adr/0006-react-token-widgets.md)): `render` returns a `WidgetEl` + `component: BibleChip`; the core serializes it to a `<dotflowy-widget>` atom and mounts `BibleChip` (`chip.tsx`) — lucide icons + Tailwind, **no plugin CSS**. `readSource` reads `data-src`; the caret jumps over it.
- v1 is liberal by explicit call (accepts `Matthew 5 minutes` → `Matthew 5`); tightening is a one-line regex change. Covered by `e2e/route-bible.spec.ts`.

## Inline emphasis (`src/plugins/emphasis/`)

Bold / italic / strikethrough / underline — `**b**`, `*i*`, `~~s~~`, `~u~` (Bear-style, all four are Bear's markup) — **parsed from `node.text`** (no `Node` field, no migration) as **folding tokens modelled on the rich link** ([ADR 0025](./docs/adr/0025-inline-emphasis.md)). Do NOT model them as a new "edged"/CSS-pseudo token shape (a prior attempt did; it can't put the caret *between* the interior and a marker, which is the whole point).

- **Fold = the link atom, reused verbatim.** A run folds to `<em data-src="*i*" contenteditable="false">i</em>` — the exact `data-src` atom shape a folded link uses, so `readSource` + the source-offset caret math handle it with **zero new machinery** (keyed on `data-src`, ADR 0001 D6). No `inline-code.ts` changes. This is why emphasis is a `folds: true` `TokenSpec`, not a bespoke shape.
- **Reveal = real, walk-through markers.** When the caret is within/adjacent (`revealOffset ∈ [start, end]`) the run swaps to `*<em>i</em>*` where the `*` are **real, dimmed `.md-punct` text** OUTSIDE the styled tag — so the caret steps through the fence one char at a time and can land at `*i|*`. Same reveal watcher as links; the fold/reveal focus+blur guard in **both** render paths (`OutlineRow`/`OutlineNode`) is now the generic **`hasFoldingToken`**, not `hasLink`.
- **Precedence coupling.** `**`/`*` and `~~`/`~` share a leading char, so bold (30) + strike (31) sit before italic (32) + underline (33) in the combined regex (double-char wins on overlap). v1 is FLAT — no nesting, no `***triple***`. The single-tilde `~underline~` collides with the "approximately" tilde by design (Bear parity; creation is Cmd+U/`/underline`, so it's rarely hand-typed).
- **Creation:** Seam C (`/bold` etc.) + Seam D (`Mod+B`/`Mod+I`/`Mod+U`/`Mod+Shift+X`, all browser-native contentEditable commands the keymap's preventDefault overrides) via `wrap.ts` (source-space wrap-or-insert). Styles its tags with Tailwind utilities on the token `El` (the `util` field) — there is no plugin `styles` seam (ADR 0031 retired raw plugin CSS). Search/display flatten via `flattenInline` (`src/data/inline-text.ts` = `stripEmphasis ∘ stripLinks`). Covered by `e2e/emphasis.spec.ts`.
- **Inline code shares this model.** The `code` plugin (`` `code` ``) is now a `folds: true` token too — backticks hide, reveal as dimmed `.md-punct` text INSIDE the `<code>` box on proximity (was: always-visible backticks). Same atom-when-folded shape, no extra core machinery. `e2e/inline-code.spec.ts`.

## Environment gotcha: adding a React-importing dependency

`bun add`-ing a package that imports React (e.g. `lucide-react`) while `bun run dev` is running may crash with "Invalid hook call / multiple copies of React" — a stale Vite dep-optimize cache, not a code bug. Fix: stop the server, `rm -rf node_modules/.vite`, restart.

## Verifying UI changes

Screenshots **cannot capture view-transition overlays** (they show the settled DOM, so a morph always looks "done"). Verify transitions by instrumenting `document.startViewTransition` and asserting on which element holds `view-transition-name`.
