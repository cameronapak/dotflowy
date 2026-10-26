# Contributing to Dotflowy

Thanks for hacking on Dotflowy. This is the practical "get it running and ship a
change" guide. Two companion docs go deeper:

- **[`README.md`](./README.md)** — what Dotflowy is, at a glance. Read it
  first, then **[`docs/architecture.md`](./docs/architecture.md)** for the data
  model, the sync design, and the project layout.
- **[`AGENTS.md`](./AGENTS.md)** (symlinked as `CLAUDE.md`) — always-on
  identity, guardrails, and pointers. Task landmines live in the doc each
  pointer names.

## Prerequisites

- **[Bun](https://bun.com)** — use the version pinned by `packageManager` in
  `package.json`. Bun is the package manager and script runner.
  npm/pnpm/yarn also work, but every command below assumes Bun.
- **Node.js** ≥ 22.19.0 — required for the CLI and compatible with the app's
  Vite and Wrangler toolchains. Installing Bun does not install Node.
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

On Cam's machine `bun run dev` on :3000 has a broken database. Agents use
`bun run cf:dev` on :8787 (one origin, closer to prod). Vite proxies for `/api`
need `ws: true` — the string shorthand does not upgrade WebSockets
(`vite.config.ts` already sets this).

### Sign in

`bun run seed:user` creates a ready-to-use dev account
(`dev@dotflowy.local` / `dotflowy-dev`) through the real sign-up endpoint —
run it once the Worker is up and sign in with those credentials. It reads the
invite code from your local `.dev.vars` `INVITE_CODES` (or skips it when
`SIGNUP_OPEN=true`), so it works whatever your invite value is. Prefer your
own account? Sign up by hand with invite code `dev-invite`.

### Check local HTTP and WebSocket sync

If Vite chooses another port because :3000 is busy, open the URL from the Vite
log. The browser should talk to the Worker through Vite's `/api` proxy, so check
both paths when debugging local setup:

```sh
curl -i http://localhost:3000/api/nodes
# unauthenticated curl may return 401, but it should be a Worker response
```

HTTP success is not enough; the outline sync path is a WebSocket. After signing
in locally, run this in the browser console at the actual app URL. It works
through Vite or on the single-origin `cf:dev` server:

```js
console.log((await fetch("/api/nodes")).status); // 200
const socket = new WebSocket(
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sync`,
);
socket.onopen = () =>
  socket.send(JSON.stringify({ type: "hello", since: null }));
socket.onmessage = (event) => {
  console.log(JSON.parse(event.data).type); // snapshot
  socket.close();
};
```

The server sends the snapshot only after the `hello` handshake. If the
browser logs "WebSocket is closed before the connection is established" or
bootstrap says "sync socket closed before initial data", inspect the Worker
logs and the `/api/sync` upgrade. The Vite proxy needs WebSocket support for `/api`
(`ws: true` in object form), and Vite must be restarted after any
`vite.config.ts` proxy edit.

Local auth testing should use a real local account created with the invite code
from your local `.dev.vars`. If you temporarily add an auth bypass for manual
testing, keep it uncommitted and exclude it from PRs unless the PR is explicitly
about productizing that bypass.

### Production-like loop (one server)

```sh
bun run cf:dev    # vite build + wrangler dev, rebuilding on src/ changes
```

Serves the built SPA and the Worker from a single origin on :8787 — closer to
prod, slower (~1–2s full build per save). Use it when you're debugging the real
Worker/DO/asset path rather than UI. See `scripts/cf-dev.ts` for the details.

### Landing page

`bun run --cwd landing dev` serves the separate marketing site on :3100.
It uses `landing/vite.config.ts`, not the app's Vite configuration. In an orb,
start a supervised service with `--port 3100` so its portal matches Vite's port.

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

Entitlement reads never call Stripe. `getPlan(userId, env)` is one D1 query on
`referenceId = user.id`, `status IN ('active','trialing')`. Free tier is no
row. An operator-comped user is a hand-inserted active row with no Stripe ids.
Keep the founding seat cap in `getCheckoutSessionParams` at checkout-creation
time. Webhooks and `subscription.list()` resolve plans from that same list.

## Testing

A test earns its place by catching a regression nothing cheaper would catch.
More green checks are not more confidence: every test costs run time and edit
time. Write fewer, longer tests. While you build, write whatever tests check
your work; a later pruning pass decides which ones stay. These rules adapt Kent C. Dodds'
[testing principles](https://github.com/kentcdodds/kody/blob/main/docs/contributing/testing-principles.md).

### Pick the lightest flavor that can falsify the behavior

| Flavor                              | Use it for                                                                                                                 | Command            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Unit, `*.test.ts` beside its module | Pure logic: `tree.ts`, parsers, tokens, the Worker planners and schemas.                                                   | `bun run test`     |
| Worker, `worker/*-real.test.ts`     | The bundled Worker and its Durable Objects under Miniflare, with no browser: HTTP, auth, and storage together.             | `bun run test`     |
| CLI, `cli/test/`                    | The built executable against loopback fixtures.                                                                            | `bun run test:cli` |
| Playwright, `e2e/*.spec.ts`         | A few user-critical journeys, and behavior only a real browser shows: caret, contentEditable, layout, the collection path. | `bun run test:e2e` |

Unit tests reach pure functions; the DOM path belongs to Playwright, because a
mocked DOM proves only the mock. When an e2e case is really exercising a parser
or planner, test that function in `bun test` and keep only the journey in the
browser.

### Write each test as one workflow

- **One test is one workflow**: setup, actions, then every assertion that
  proves it. Read it like a manual tester's script.
- Write flat top-level `test(...)` calls with the setup inline, so each test
  reads top to bottom on its own. For many input-output pairs of one function,
  use one table test (`test.each`).
- **Every assertion needs an independent oracle**: a literal, or a value you
  derive by hand. An expected value from the code under test, an exported
  constant, or a copy of the production helper agrees with the bug. Write
  `NOW - 30 * DAY_MS`, not `NOW - RESTORE_WINDOW_MS`.
- **One behavior, one home.** Test it beside the module that owns it. A
  re-export inherits its source's tests.
- Assert on what callers and users rely on. Copy, error message wording,
  styling, animation timing, and facts the type checker enforces stay unpinned.
- Test paths a caller can reach. An edge case or fallback that no input can
  trigger stays untested.
- An absence assertion runs on a path that can still show the thing: empty
  versus populated, admin versus user.
- **A perf guard asserts a countable invariant**, such as a render or
  registration count, never a wall clock.

### Hold Playwright to a high bar

- Grow an existing journey before you add a spec. Add a spec only when the flow
  is user-critical and no faster test can cover it.
- A bug fix gets its regression test at the lowest layer that reproduces it.
- Locate by role or label (`getByRole`, `getByLabel`); reach for a CSS locator
  only when no accessible one exists. Press `ControlOrMeta+…`, never a bare
  `Meta+`.
- Wait on state (`expect(...)` retries, `expect.poll`), never on a fixed
  `waitForTimeout`.
- **CI's `quality` gate requires all checks and the full browser regression.**
  Nonbrowser checks and the real-Worker suite run once, alongside eight isolated CI
  runners that each run one app shard with one worker, zero retries, and retained
  failure traces. Every app test runs on exactly one shard; each shard stops at
  its first failure without canceling the others. Per-test JSON timing reports
  are uploaded on every run. Require `quality` in branch rules before relying
  on it instead of a full local browser run.
  PRs run CI directly; `main` uses deployment's exact-commit call, not a second
  standalone CI run. New PR revisions cancel superseded CI and CLI runs;
  production validation and exact-candidate dispatches are not canceled this way.
  The full app run includes the editor performance cases; use `bun run test:perf`
  for focused local iteration, not a duplicate CI run.
  `bun run test:e2e:app` is the app-only run;
  `bun run test:e2e` also runs the isolated real-Worker suite. Use
  `--workers=2` only when the machine has spare capacity. Both suites default to
  one worker; `bun run test:e2e:serial` also explicitly pins the app worker count.
  Investigate contention failures rather than masking them with retries.
  The app suite runs its own Vite
  server on port 3210; kill a zombie or set `E2E_PORT`. For a caret, set the
  Selection range directly. `toHaveText` normalizes whitespace.

### Test within a medium Orb's budget

A medium Orb exposes 4 CPUs and 8 GB of host RAM, but command workloads can have
a smaller cgroup limit: the investigated Orb allowed 6 GiB. Inspect
`/proc/self/cgroup` and the ancestor slice's `memory.max`, `memory.current`, and
`memory.events`; host free memory and summed process RSS do not measure that
budget. The cgroup count includes filesystem cache; inspect `memory.stat`'s
`anon` and `file` values and event deltas before attributing usage to live
processes. CPU at 100% alone does not establish memory pressure.

Root build, test, and typecheck scripts automatically share one heavy-work lane
when `AMP_ORB` is set. The native `flock` lock is shared across worktrees and
lives in the Orb's shared temporary directory. It is released when the command
exits; nested commands inherit it. `cf:dev` rebuilds use the same build script.
Outside an Orb, the wrapper runs commands directly.
For direct tools or package-local commands, use
`bun scripts/heavy-lane.ts <command> [args...]`. Different `E2E_PORT` values
prevent port collisions, not resource contention.

- During iteration, run the affected files before the full gate:
  `bun scripts/heavy-lane.ts bun test ./src/data/tree.test.ts` or
  `bun run test:e2e:app e2e/keyboard-nav.spec.ts`.
- Keep the one-worker browser default. Each extra worker adds a test process
  and a browser process tree alongside the shared Vite server. The real-Worker
  suite already uses one worker, and `test:e2e` runs the two suites in sequence.
  CI sharding uses separate machines, not additional workers inside one Orb.
- Stop idle development services before the full browser run. Playwright owns
  its Vite server; the app fixtures mock the data API, and the real-Worker suite
  owns an isolated Miniflare runtime. Neither needs a separate `cf:dev` server.
  In an Orb, inspect `amp orb service list` and stop only services you own with
  `amp orb service stop <name>`.
- Keep coverage, Playwright UI mode, and traces off during routine runs.
  The existing config records a trace on the first retry, not for every test.
  For a focused failure, opt in with `--trace=retain-on-failure`.
- Orb setup selects the pinned Bun for both login and non-login shells and
  installs Chromium, WebKit, and their Linux dependencies. Resume does not
  reinstall them. Verify `command -v bun` and `bun --version` before benchmarking.

Sustained memory pressure, killed processes, and contention-induced timeouts
are reasons to reduce overlap, not to increase retries or timeouts. Lowering
browser concurrency trades throughput for memory headroom without skipping tests.

### Keep test seams out of production

Ask: would production keep this code if every test were deleted? If not, it
belongs in the test file or `e2e/fixtures.ts`. Reach behavior through public
interfaces, the Effect `TestClock`, and fixture route mocks.

### Prune

A test that was valuable when written is not valuable forever. When asked to
prune or tighten tests:

1. Read each test in scope against every rule in this section.
2. Rewrite or move a test that breaks a rule while preserving distinct reachable
   setups. Delete it only when another test provides equivalent coverage or the
   path is no longer reachable. Move an e2e case that only exercises logic down
   to `bun test`. Delete a test that only checked work in progress, such as one
   proving a removed feature is gone.
3. Run `bun run test`, plus each e2e spec you changed.

The pass is done when every remaining test satisfies every rule, the PR
description lists what you deleted, consolidated, and kept (each deletion names
the rule it broke; each kept test that looks borderline says why it stays), and
the gates are green. Line reduction is not a completion criterion. Lunora
retirement tests leave with their modules
([ADR 0061](./docs/adr/0061-retire-lunora-through-per-user-cutover.md)), not in
a pruning pass.

## Before you open a PR

Run these nonbrowser checks and the affected browser specs locally. CI owns the
full browser regression once its `quality` job is required and green on the PR.
Until then, also run `bun run test:e2e:serial` locally. A green required full CI
run replaces the duplicate full local run, not focused checks or visual review.

```sh
bun run fmt:check       # oxfmt
bun run lint            # oxlint over src + worker + CLI source, tests, and scripts
bun run typecheck       # tsc over the app (DOM libs)
bun run typecheck:worker # tsc over worker/ (workers-types)
bun run typecheck:test  # tsc over the unit tests (bun types)
bun run typecheck:e2e   # tsc over app Playwright specs and fixtures, no browser
bun run test            # bun test — unit tests plus the Miniflare Worker suite (src + worker/)
bun test scripts/release.test.ts scripts/shortcut.test.ts scripts/heavy-lane.test.ts
bun run check:docs
bunx changeset          # describe your change for the changelog (see below)
bun run check:changeset # verify the committed branch carries that decision
```

Then **run the app**: before calling an observable change done, drive it in
`bun run cf:dev` — or exercise it through an e2e spec — and confirm the
behavior. Green gates are necessary, not sufficient. Skip only for changes with
no runtime surface (docs, types, tooling).

For a visible change, derive a state matrix from every styling branch the diff
adds or changes. Exercise and inspect each visually distinct state; the default
state cannot verify selected, active, loading, error, or responsive variants.

E2E tests use Chromium, plus a WebKit regression for touch selection in typing
suggestions. Install both with `bunx playwright install chromium webkit`.
Linux WebKit does not reproduce the iPhone keyboard or safe-area behavior.

### Package checks

Run the root gate above, plus the checks for the package you changed. Commands
below run from the repository root. Root CI's `quality` job already runs CLI
lint through `bun run lint`; `lint:cli` is the focused local command.

| Surface | Additional checks                                                                                                       | Runtime or fixtures                                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor  | `bun run test:e2e:app e2e/<name>.spec.ts --workers=1`                                                                   | Playwright starts its own Vite development server on `E2E_PORT` (default 3210). [`e2e/fixtures.ts`](./e2e/fixtures.ts) mocks the data API.                                                                          |
| CLI     | `bun run lint:cli`, `bun run build:cli`, `bun run typecheck:cli`, `bun run test:cli`, `bun run --cwd cli check:package` | Install `cli/` dependencies first with `bun install --cwd cli --frozen-lockfile`. Tests run the Node executable against loopback fixtures. The [live test](./cli/README.md#development-and-verification) is opt-in. |
| Landing | `bun run --cwd landing typecheck`, `bun run --cwd landing build`                                                        | Install `landing/` dependencies first. Inspect the rendered change at desktop and mobile widths.                                                                                                                    |

E2E tests run against Vite development mode. Quick-add's deferred-resolve tests
hold the real Daily claim request through `holdDailyClaims` in the fixture;
they do not require development-only app hooks. The committed Playwright config
invokes the installed Vite entry point directly
to avoid nested Bun script PATH failures. It rejects a busy port instead of
adopting another checkout's server; set `E2E_PORT` for concurrent runs.

### Profile editor performance

Run `bun run test:perf` after changing editor rendering, subscriptions, or
virtualization. This browser suite runs locally and in CI. It checks render isolation, layout-cache
reuse, resize behavior, mounted-row bounds, and hotkey registration counts.
The day-stream guard must observe real editor renders before asserting that
unchanged content and layout stay cached. It adds no production counters.

Use [React Doctor](https://www.react.doctor/docs/overview/quickstart) for two
different tasks:

- **Static audit:** `bunx react-doctor@0.9.18 --scope changed --base HEAD --verbose --no-score --no-supply-chain`
  checks uncommitted tracked changes against `HEAD`. For a branch audit, use
  `--base origin/main`. Treat findings as hypotheses, not measured costs. Keep
  the editor's intentional compiler opt-out and manual memos (ADR 0019 and
  ADR 0004).
- **Runtime profile:** with `bun run cf:dev` running, use
  `bunx react-doctor@0.9.18 scan http://localhost:8787 --trace-out /tmp/dotflowy-scroll.json.gz`.
  Sign in in the profiler's browser, open a populated Daily note, reproduce one
  interaction, then press Enter in the terminal to finish. Profile typing and
  scrolling separately. Chrome DevTools Performance and React DevTools Profiler
  are alternatives. Keep traces private: they can contain URLs and outline data.

Compare the same outline, viewport, and interaction before and after a fix.
Distinguish viewport renders, new mounts, and real resizes from unchanged-content
renders and full-list rebuilds. Test a populated day, empty days, loading earlier
days, and viewport resizing. Preserve a countable regression guard rather than
a machine-dependent millisecond budget. React Doctor remains a manual audit;
CI includes these guards in the full app suite, without a duplicate focused run.
Failed shards retain browser diagnostics, including first-failure traces, for
seven days in the `e2e-failure-traces-<shard>` artifact.

For repeatable large-outline measurements, run `bun run bench:outline` against
`bun run cf:dev` (or a production build served by `vite preview` on port 8787).
If you use `vite preview`, restart it after each build so it loads the new assets.
The harness uses synthetic 10k and 100k outlines with mixed and wide sibling
lists. It mocks auth, HTTP, and WebSocket transport through `e2e/fixtures.ts`;
it does not write to your account or measure backend latency.

```sh
LABEL=before bun run bench:outline
# Rebuild with the change, then repeat with no other benchmarks running.
LABEL=after bun run bench:outline
# Optional CPU profile of one action, separate from the timing comparison:
LABEL=profile REPEATS=1 SIZES=100000 TOPOLOGIES=mixed PROFILE_ACTION=drag bun run bench:outline
```

JSON results go to `/tmp/dotflowy-benchmark` (`BENCH_OUT` overrides it).
`BENCH_URL`, `CHROME_PATH`, `SIZES`, `TOPOLOGIES`, and `REPEATS` override the server,
browser executable, node counts, tree topologies, and repetitions. Defaults use three
fresh browser contexts per topology and size. Actions cover typing, filtering,
keyboard reorder, drag, paste, undo, and redo; paste/history checks compare all
persisted fields except `updatedAt`. Set `TYPING_ONLY=true` for a focused load
and typing comparison. `PROFILE_ACTION` accepts comma-separated action names.
CDP `taskMs` includes the action, its DOM
check, and two animation frames. It measures main-thread CPU, not INP or actual
paint latency. Compare medians and raw samples; three repetitions cannot
establish p95. Keep CPU profiles separate because profiling adds overhead.

The default seed uses `updatedAt: 0`, like the other browser fixtures. Also run
with `SEED_UPDATED_AT=1700000000000` to compare timestamp-sized inputs. The first
edit changes zero into an epoch timestamp; Chromium's object-copy costs can
differ substantially between these cases. Keep both results rather than
discarding the zero-timestamp stress case.

### Review and release conventions

Rules of thumb:

- **Every PR carries a changeset.** `bunx changeset` writes a fragment saying what
  changed and how loudly — `major` when a reader has to _do_ something, `minor` for
  a new capability, `patch` for a fix. If the PR isn't news (a `chore:`, a refactor),
  say so with `bunx changeset --empty`. Commit the fragment, then run
  `bun run check:changeset`; its comparison reads committed history. CI runs the
  same command. Releases are cut with `bun run release` — **never
  `changeset version` directly**, which would delete the fragments before they're
  archived. See [ADR 0046](./docs/adr/0046-changelog-and-release-versioning.md).

- **The CLI has a second, independent Changesets project.** A change to packaged
  CLI behavior also runs `cd cli && bun run changeset`. This includes `cli/src/**`,
  the packaged `cli/README.md` and `cli/LICENSE`, and meaningful published package
  metadata. The release PR's version bump and development-only scripts,
  devDependencies, tests, and release machinery are exempt. The root fragment
  describes the app/repository change; the CLI fragment chooses the public npm
  package's semver and feeds `cli/CHANGELOG.md`. The `CLI Release` workflow
  maintains the release PR; merging that PR approves publication. See
  [ADR 0062](./docs/adr/0062-automated-cli-releases.md).

- **react-doctor is an occasional manual audit, not a gate** — its accepted
  editor false-positives (the deliberately kept manual memos) are known noise
  on every run, so it stays out of the recurring validation set.
- **Session handoffs.** `HANDOFF.md` is transient branch-local build state.
  Commit it on the branch; delete it in the shipping PR. It must not reach
  `main`.
- **`src/routeTree.gen.ts` is generated** — never hand-edit. After adding or
  renaming a file in `src/routes/`, run `bun run dev` once to regenerate it.
- **Documentation Freshness.** If you change a documented fact (a command, a
  path, repo structure), fix the affected doc (`AGENTS.md` and/or `README.md`)
  in the same change. Ask first before changing policy, philosophy, or
  positioning.

## CLI release setup

The repository contains the whole pipeline, but these account-level settings
must be configured before it can maintain release PRs or publish. Do not store a
PAT or npm token as a workaround.

1. Create a GitHub App for CLI release PRs. Disable webhooks. Grant repository
   **Contents: Read and write**, **Pull requests: Read and write**, and the
   implicit **Metadata: Read-only** permission. Install it only on
   `cameronapak/dotflowy`. Add its client ID as the repository variable
   `CLI_RELEASE_APP_CLIENT_ID` and its private key as the repository secret
   `CLI_RELEASE_APP_PRIVATE_KEY`.
2. Create a GitHub Environment named exactly `npm`. Restrict deployment branches
   to `main`, but add no required reviewers or wait timer. The merged release PR
   is the human approval, so the environment must not add a second approval.
3. Before enforcing main protection, land universal PR checks and verify hosted
   candidate validation and protected promotion as described in
   [ADR 0073](./docs/adr/0073-exact-sha-checked-app-release-candidates.md). Require
   `test (ubuntu-latest, 22)`, `test (ubuntu-latest, 24)`,
   `test (macos-latest, 22)`, `test (macos-latest, 24)`,
   `test (windows-latest, 22)`, `test (windows-latest, 24)`, and `changeset`,
   bound to the GitHub Actions producer (App ID 15368). Enable strict up-to-date
   checks and administrator enforcement, with no bypass, force pushes, or main
   deletion. Do not add a PR-required rule to this direct-promotion design.
   Every PR runs the real checks; the version-only release PR passes the
   content-based changeset exemption rather than skipping the job. Allow the
   installed GitHub App to create and update its release branch and PR, not to
   bypass main protection.
4. After this pipeline is on `main`, bootstrap the unclaimed npm package once
   from a clean, current `main` checkout. Use Node 24 and npm 11.5.1+ with an npm
   owner account protected by 2FA. Record `git rev-parse HEAD` as the bootstrap
   commit, and do not commit or merge anything between this publish and step 6.

   ```sh
   cd cli
   bun install --frozen-lockfile
   bun run build
   bun run typecheck
   bun run test
   bun run check:package
   git rev-parse HEAD
   npm publish --access public
   ```

5. On npmjs.com, open `dotflowy` package settings and add a GitHub Actions Trusted
   Publisher with organization/user `cameronapak`, repository `dotflowy`, workflow
   filename `cli-release.yml`, environment `npm`, and direct `npm publish`
   allowed. Then set Publishing access to **Require two-factor authentication and
   disallow tokens**. No npm credential belongs in GitHub.
6. Manually run the `CLI Release` workflow once with `bootstrap_commit` set to
   the exact SHA recorded in step 4. It verifies the published `0.1.0`, creates
   `dotflowy@0.1.0` at that commit if absent, and creates the matching GitHub
   Release. Later releases need no manual dispatch or commit input.

The publish job is safe to rerun. It rebuilds and retests on Linux Node 24, skips
an npm version that already exists, repairs a missing tag or GitHub Release, and
fails rather than moving a conflicting tag.

## Conventions worth knowing

- **Skills first.** Use matching skills already listed in context. If none
  matches, run `bunx @tanstack/intent@latest list` once and load a relevant skill
  if one fits (see the Skill Loading block in `AGENTS.md`).
- **The typed-error channel in Effect is the error model.** Effect v4 source
  comes via opensrc — `bunx opensrc path Effect-TS/effect-smol` prints a
  machine-global cached copy (`bun run setup` pre-warms it). Read from it,
  never import from it; app/worker code imports `effect` from npm. Read the
  fetched repo's `AGENTS.md` before writing Effect. `kv-api.ts` must keep
  throwing — TanStack DB rolls back on throw.
- **Plugins** live in `src/plugins/<name>/`; adding a feature is a folder plus one
  line in `src/plugins/index.ts` ([ADR 0001](./docs/adr/0001-plugin-architecture.md)).
- **Structural edits are atomic; field edits are direct.** Tree-shape changes
  go through `runStructural` at the call site, not inside `mutations.ts`.
  Field edits stay a direct PATCH ([ADR 0009](./docs/adr/0009-atomic-structural-writes.md)).
- **Load-bearing decisions are ADRs** in `docs/adr/`, numbered sequentially. A
  decision earns one when it's hard to reverse and surprising without context;
  otherwise the code is the doc.
- **After `bun add` of a React-importing package**, clear `node_modules/.vite`
  if the dev server dies on an invalid hook call.
- **The Codex app rewrites `.codex/environments/environment.toml`** and drops
  comments. Put no load-bearing explanation there.
- **Capture a repeated incantation** in a `package.json` script or a config
  file. Reach for `scripts/*.ts` only when there is no config home.

## Deploying

Merging to `main` approves automatic app release and deployment: quality checks,
both builds, seven real CLI checks on the exact candidate SHA, atomic promotion,
GitHub Release, landing deploy, then app deploy. Pending runs use the newest
`main`; failures stop without automatic rollback. Setup and retry steps:
[`docs/deploying.md`](./docs/deploying.md#automatic-production-deployment).

For a manual or self-hosted deploy: `wrangler login`, set the production secrets,
run `bun run db:migrate:remote` **before** the first deploy, then `bun run deploy`.
The separate landing command is `bun run --cwd landing deploy`. Manual deploys
ship whatever is checked out. CI does not run D1 migrations or data backfills.

## Questions

Open an issue, or if you're an agent, the local issue tracker lives under
`.scratch/<feature-slug>/` (see `docs/agents/issue-tracker.md`).
