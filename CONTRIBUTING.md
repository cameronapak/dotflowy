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
bun run setup    # copies .dev.vars, generates BETTER_AUTH_SECRET, applies local D1 schema
```

`setup` is idempotent — safe to re-run any time. Signup is invite-gated (alpha):
the local invite code is **`dev-invite`**, the code to use when creating a
local account by hand. No codes = signup closed.

### Worktrees provision themselves

Worktrees created by Claude Code (`claude --worktree`, or an agent running with
`isolation: "worktree"`) skip the two commands above — a `WorktreeCreate` hook
(`.claude/hooks/create-worktree.ts`, wired up in `.claude/settings.json`) runs
them for you, plus copies the entries listed in `.worktreeinclude` (e.g. `.dev.vars`, `.codegraph`) from the base repo. A
fresh worktree can run `typecheck`, `lint`, and `test` immediately.

The one thing it can't do is `bun run seed:user`, which signs up through the
live Worker and so needs `bun run dev` already running. Seed the worktree's D1
by hand the first time you want to sign in there.

## Running locally

Dotflowy is a static SPA that talks to a Cloudflare Worker over `/api/*`, so the
real local setup runs both: Vite for the UI and Wrangler for the Worker + the
per-user Durable Object it routes to.

### Fast loop — the default

```sh
bun run dev      # vite (:3000) + wrangler (:8787) together; HMR for the UI
```

Open http://localhost:3000. Vite gives you HMR; the Worker reloads on its own
edits. This is the loop for almost all work. `bun run dev:api` + `bun run dev:web`
still exist if you want the two servers in separate terminals with isolated logs.

### Sign in

`bun run seed:user` creates a ready-to-use dev account
(`dev@dotflowy.local` / `dotflowy-dev`) through the real sign-up endpoint —
run it once the Worker is up and sign in with those credentials. Prefer your
own account? Sign up by hand with invite code `dev-invite`.

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
- **Effect v4 source comes via opensrc** — `bunx opensrc path Effect-TS/effect-smol`
  prints a machine-global cached copy (`bun run setup` pre-warms it). Read from it,
  never import from it; app/worker code imports `effect` from npm. Read the fetched
  repo's `AGENTS.md` before writing Effect.
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
