# Contributing to Dotflowy

Thanks for hacking on Dotflowy. This is the practical "get it running and ship a
change" guide. Two companion docs go deeper:

- **[`README.md`](./README.md)** — what Dotflowy is, at a glance. Read it
  first, then **[`docs/architecture.md`](./docs/architecture.md)** for the data
  model, the sync design, and the project layout.
- **[`AGENTS.md`](./AGENTS.md)** (symlinked as `CLAUDE.md`) — the per-feature
  rules and gotchas. It's written for coding agents but it's the canonical
  reference for _why_ the code is shaped the way it is. Read the section that
  covers whatever you're touching before you touch it.

## Prerequisites

- **[Bun](https://bun.com)** ≥ 1.4 — the package manager and script runner.
  npm/pnpm/yarn also work, but every command below assumes Bun.
- **Wrangler** — Cloudflare's CLI. It's a dev dependency (`bunx wrangler …`), so
  `bun install` gets it; nothing to install globally.
- **A Cloudflare account** — only needed to deploy or run migrations against the
  _remote_ database. Local development runs fully offline (Wrangler's local
  Worker + a local SQLite-backed D1 + Durable Objects). No account required.
- macOS or Linux. Windows via WSL should work but is untested.

## First-time setup

```sh
bun install
bun run setup    # copies .dev.vars, generates BETTER_AUTH_SECRET, applies local D1 schema
```

`setup` is idempotent — safe to re-run any time. Production signup is open, but
the local default keeps it invite-gated: the local invite code is
**`dev-invite`**, the code to use when creating a local account by hand. Set
`SIGNUP_OPEN=true` in `.dev.vars` to mirror prod's open signup locally.

### Worktrees provision themselves

Worktrees skip the two commands above. Both supported agent harnesses run
`scripts/bootstrap.ts` when they create one, which copies the entries listed in
`.worktreeinclude` (e.g. `.dev.vars`, `.codegraph`) from the base repo, then
runs `bun install` and `bun run setup`. A fresh worktree can run `typecheck`,
`lint`, and `test` immediately.

- **Claude Code** (`claude --worktree`, or an agent running with
  `isolation: "worktree"`) — the `WorktreeCreate` hook
  (`.claude/hooks/create-worktree.ts`, wired up in `.claude/settings.json`).
- **Codex app** — the `[setup] script` in `.codex/environments/environment.toml`,
  which the app runs when it creates a worktree for a task. Committed, so it
  applies to every clone. Codex CLI has no worktree lifecycle at all; run
  `bun run bootstrap` yourself after `git worktree add`.

Anywhere else — a plain clone included — `bun run bootstrap` does the same
three steps by hand. It's idempotent, and it never overwrites a file the
checkout already has.

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
run it once the Worker is up and sign in with those credentials. It reads the
invite code from your local `.dev.vars` `INVITE_CODES` (or skips it when
`SIGNUP_OPEN=true`), so it works whatever your invite value is. Prefer your
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
Neither is needed in prod (there the origin genuinely _is_ the prod domain). See
[ADR 0026](./docs/adr/0026-agent-native-mcp-server.md).

### Testing Stripe billing locally

Billing is optional in dev — with no Stripe vars set, everything except the
billing endpoints works. To exercise checkout/webhooks locally you need the
[Stripe CLI](https://docs.stripe.com/stripe-cli) and a test-mode API key:

```sh
stripe listen --forward-to localhost:8787/api/auth/stripe/webhook
```

Put the test key and the `whsec_…` secret that `stripe listen` prints into
`.dev.vars` as `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (see
`.dev.vars.example`), then restart `bun run dev:api`. Test-mode Prices must
carry the lookup keys in `worker/auth.ts` (`STRIPE_LOOKUP_KEYS`) — the code
references prices by lookup key, never by id, so test and live mode need no
config difference.

Create those Prices (and their Products) with the idempotent setup script
instead of hand-running `stripe prices create`:

```sh
STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts            # test mode
STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts --dry-run  # plan only, no writes
```

The lookup keys are the state (no state file); re-running only creates what's
missing. Test mode skips the webhook endpoint (that's what `stripe listen` is
for). For prod, run it once against the live key with the explicit `--live`
guard — `STRIPE_SECRET_KEY=sk_live_… bun scripts/stripe-setup.ts --live` — which
also registers the `app.dotflowy.com` webhook endpoint and prints the `whsec_…`
signing secret once (feed it to `wrangler secret put STRIPE_WEBHOOK_SECRET`).

## Before you open a PR

Run the full gate. These mirror CI — except `bun run test:e2e`, which is
local-only — and are the same checks the review process expects to pass:

```sh
bun run fmt:check       # oxfmt
bun run lint            # oxlint (correctness = error) over src + worker
bun run typecheck       # tsc over the app (DOM libs)
bun run typecheck:worker # tsc over worker/ (workers-types)
bun run typecheck:test  # tsc over the unit tests (bun types)
bun run test            # bun test — pure-logic unit tests (src + worker/)
bun run test:e2e        # playwright (chromium) — behavior/integration
bunx changeset          # describe your change for the changelog (see below)
```

Then **run the app**: before calling an observable change done, drive it in the
running app (`bun run dev`) — or exercise it through an e2e spec — and confirm
the behavior. Green gates are necessary, not sufficient (see _Run the app
before declaring done_ in `AGENTS.md`). Skip only for changes with no runtime
surface (docs, types, tooling).

Rules of thumb, expanded in `AGENTS.md`:

- **Every PR carries a changeset.** `bunx changeset` writes a fragment saying what
  changed and how loudly — `major` when a reader has to _do_ something, `minor` for
  a new capability, `patch` for a fix. If the PR isn't news (a `chore:`, a refactor),
  say so with `bunx changeset --empty`. CI checks that you decided; it does not ask
  you to invent an entry. Releases are cut with `bun run release` — **never
  `changeset version` directly**, which would delete the fragments before they're
  archived. See [ADR 0046](./docs/adr/0046-changelog-and-release-versioning.md).

- **Unit tests (`bun test`) cover pure logic only** — `tree.ts`, `tags.ts`,
  `links.ts`, the Worker planners/schemas. Editor behavior (caret, contentEditable,
  the collection/DO path) stays in **Playwright** (`e2e/`). Don't unit-test the
  DOM path; you'd just be mocking the world.
- **Chasing a flake? `bun run test:e2e:serial`** (`--workers=1`) is the
  maximum-determinism local run; `--workers=2` is the clean-signal full run
  before a PR. **e2e does not run in CI** — Playwright is a local pre-PR gate,
  so running it here is what stands in for a CI check. A parallel-contention
  flake isn't a real failure.
- **react-doctor is an occasional manual audit, not a gate** — its accepted
  editor false-positives (the deliberately kept manual memos) are known noise
  on every run, so it stays out of the recurring validation set.
- **Shipping a multi-session branch? Delete `HANDOFF.md`** — it's transient
  branch-local build state (see _Session handoffs_ in `AGENTS.md`) and must not
  reach `main`.
- **`src/routeTree.gen.ts` is generated** — never hand-edit. After adding or
  renaming a file in `src/routes/`, run `bun run dev` once to regenerate it.
- If you change a documented fact (a command, a path, repo structure), fix the
  affected doc (`AGENTS.md` and/or `README.md`) in the same change. See
  _Documentation Freshness_ in `AGENTS.md`.
- **PR descriptions follow the snapshot template** in
  `.agents/skills/ft-create-concise-pr/SKILL.md` (agents: run
  `/ft-create-concise-pr`) — one consistent, skimmable shape for every review.

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

Covered in [`docs/deploying.md`](./docs/deploying.md). The short version: `wrangler login`,
set the prod secret once (`wrangler secret put BETTER_AUTH_SECRET`), run
`bun run db:migrate:remote` **before** the first `bun run deploy`, then
`bun run deploy`. Deploys ship whatever's checked out — prefer merging to `main`
first so prod tracks `main`.

## Questions

Open an issue, or if you're an agent, the local issue tracker lives under
`.scratch/<feature-slug>/` (see `docs/agents/issue-tracker.md`).
