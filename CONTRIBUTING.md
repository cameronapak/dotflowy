# Contributing to Dotflowy

Thanks for hacking on Dotflowy. This is the practical "get it running and ship a
change" guide. Two companion docs go deeper:

- **[`README.md`](./README.md)** — what Dotflowy is, the data model, the sync
  design, and the project layout. Read it first.
- **[`AGENTS.md`](./AGENTS.md)** (symlinked as `CLAUDE.md`) — the per-feature
  rules and gotchas. It's written for coding agents but it's the canonical
  reference for *why* the code is shaped the way it is. Read the section that
  covers whatever you're touching before you touch it.

## Prerequisites

- **[Bun](https://bun.com)** ≥ 1.4 — the package manager and script runner.
  npm/pnpm/yarn also work, but every command below assumes Bun.
- **Wrangler** — Cloudflare's CLI. It's a dev dependency (`bunx wrangler …`), so
  `bun install` gets it; nothing to install globally.
- **A Cloudflare account** — only needed to deploy or run migrations against the
  *remote* database. Local development runs fully offline (Wrangler's local
  Worker + a local SQLite-backed D1 + Durable Objects). No account required.
- macOS or Linux. Windows via WSL should work but is untested.

## First-time setup

```sh
bun install

# Local Worker secrets (gitignored). Generate a signing secret:
cp .dev.vars.example .dev.vars
# then set BETTER_AUTH_SECRET in .dev.vars, e.g.:
#   openssl rand -base64 32
# The Worker fails closed without it.
# Signup is invite-gated (alpha): the example file ships INVITE_CODES=dev-invite,
# which is the code to use when creating a local account. No codes = signup closed.

# Apply the local D1 schema (auth tables + the legacy import source). Once.
bun run db:migrate:local
```

## Running locally

Dotflowy is a static SPA that talks to a Cloudflare Worker over `/api/*`, so the
real local setup runs both: Vite for the UI and Wrangler for the Worker + the
per-user Durable Object it routes to.

### Fast loop (two terminals) — the default

```sh
bun run dev:api   # terminal 1: wrangler dev (Worker + DO + local D1) on :8787
bun run dev       # terminal 2: vite dev on :3000 (proxies /api -> :8787)
```

Open http://localhost:3000. Vite gives you HMR; the Worker reloads on its own
edits. This is the loop for almost all work.

If Vite chooses another port because :3000 is busy, open the URL from the Vite
log. The browser should talk to the Worker through Vite's `/api` proxy, so check
both paths when debugging local setup:

```sh
curl -i http://localhost:3000/api/nodes
# unauthenticated curl may return 401, but it should be a Worker response
```

HTTP success is not enough; the outline sync path is a WebSocket. After signing
in locally, verify the browser can `fetch("/api/nodes")` with a 200 and that
`ws://localhost:3000/api/sync` opens and emits the initial snapshot. If the
browser logs "WebSocket is closed before the connection is established" or
bootstrap says "sync socket closed before initial data", the `/api/sync` upgrade
is not reaching Wrangler. The Vite proxy needs WebSocket support for `/api`
(`ws: true` in object form), and Vite must be restarted after any
`vite.config.ts` proxy edit.

Local auth testing should use a real local account created with the invite code
from `.dev.vars.example`. If you temporarily add an auth bypass for manual
testing, keep it uncommitted and exclude it from PRs unless the PR is explicitly
about productizing that bypass.

### Production-like loop (one server)

```sh
bun run cf:dev    # vite build + wrangler dev, rebuilding on src/ changes
```

Serves the built SPA and the Worker from a single origin on :8787 — closer to
prod, slower (~1–2s full build per save). Use it when you're debugging the real
Worker/DO/asset path rather than UI. See `scripts/cf-dev.ts` for the details.

### Testing the MCP OAuth flow locally

The MCP endpoint (`/mcp`) is OAuth-gated, and testing it against `wrangler dev`
has one gotcha: the dev proxy simulates the production custom domain, so it
rewrites both the inferred issuer **and** the request `Origin` to
`app.dotflowy.com`. Two local-only vars in `.dev.vars` make the flow work (both
are documented in `.dev.vars.example`):

```sh
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_TRUSTED_ORIGINS=http://app.dotflowy.com,https://app.dotflowy.com
```

Without the first, discovery points MCP clients at the prod domain; without the
second, Better Auth's CSRF check rejects local sign-in with `403 Invalid origin`.
Neither is needed in prod (there the origin genuinely *is* the prod domain). See
[ADR 0026](./docs/adr/0026-agent-native-mcp-server.md).

## Before you open a PR

Run the full gate. These mirror CI and are the same checks the review process
expects to pass:

```sh
bun run lint            # oxlint (correctness = error) over src + worker
bun run typecheck       # tsc over the app (DOM libs)
bun run typecheck:worker # tsc over worker/ (workers-types)
bun run typecheck:test  # tsc over the unit tests (bun types)
bun run test            # bun test — pure-logic unit tests (src + worker/)
bun run test:e2e        # playwright (chromium) — behavior/integration
```

Rules of thumb, expanded in `AGENTS.md`:

- **Unit tests (`bun test`) cover pure logic only** — `tree.ts`, `tags.ts`,
  `links.ts`, the Worker planners/schemas. Editor behavior (caret, contentEditable,
  the collection/DO path) stays in **Playwright** (`e2e/`). Don't unit-test the
  DOM path; you'd just be mocking the world.
- **`src/routeTree.gen.ts` is generated** — never hand-edit. After adding or
  renaming a file in `src/routes/`, run `bun run dev` once to regenerate it.
- If you change a documented fact (a command, a path, repo structure), fix the
  affected doc (`AGENTS.md` and/or `README.md`) in the same change. See
  *Documentation Freshness* in `AGENTS.md`.

## Conventions worth knowing

`AGENTS.md` is the full reference; the headlines:

- **Skills first.** Before substantial work, run `bunx @tanstack/intent@latest list`
  and load a matching skill if one fits (see the top of `AGENTS.md`).
- **Effect v4 is vendored** at `repos/effect-smol/` for reference. Read from it,
  never import from it; app/worker code imports `effect` from npm. Read
  `repos/effect-smol/AGENTS.md` before writing Effect.
- **Plugins** live in `src/plugins/<name>/`; adding a feature is a folder plus one
  line in `src/plugins/index.ts` ([ADR 0001](./docs/adr/0001-plugin-architecture.md)).
- **Structural edits are atomic; field edits are direct.** Any tree-shape
  mutation goes through `runStructural` (one batch, echo-held); single-field edits
  stay direct ([ADR 0009](./docs/adr/0009-atomic-structural-writes.md)).
- **Load-bearing decisions are ADRs** in `docs/adr/`, numbered sequentially. A
  decision earns one when it's hard to reverse and surprising without context;
  otherwise the code is the doc.

## Deploying

Covered in [`README.md`](./README.md#deploy). The short version: `wrangler login`,
set the prod secret once (`wrangler secret put BETTER_AUTH_SECRET`), run
`bun run db:migrate:remote` **before** the first `bun run deploy`, then
`bun run deploy`. Deploys ship whatever's checked out — prefer merging to `main`
first so prod tracks `main`.

## Questions

Open an issue, or if you're an agent, the local issue tracker lives under
`.scratch/<feature-slug>/` (see `docs/agents/issue-tracker.md`).
