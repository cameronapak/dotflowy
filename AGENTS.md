# Dotflowy

A local-feeling outliner: nested bullets, per-user sync, plugin-extended editor. React SPA (no SSR) on Cloudflare Workers, with each user's outline in its own Durable Object.

Structure, data model, and the backend-swap path: [`docs/architecture.md`](./docs/architecture.md). Setup and local dev: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

This file is gotchas. It covers the traps that are invisible from the code and silent when broken. Everything else is a pointer.

## Commands

```sh
bun run setup      # once per clone: .dev.vars + BETTER_AUTH_SECRET + local D1 schema
bun run bootstrap  # setup + install + copy .worktreeinclude from base repo (what worktree hooks call)
bun run dev        # vite (:3000) + wrangler (:8787)
bun run cf:dev     # production-like single server (:8787), rebuilds on src/ change
bun run seed:user  # local dev account (dev@dotflowy.local / dotflowy-dev)
bun run build      # production build (also prerenders /)
bun run build:cf   # vite build + copy _shell.html -> index.html (Cloudflare)
bun run deploy     # build:cf, then wrangler deploy
bun run lint       # oxlint over src + worker (correctness = error)
bun run fmt        # oxfmt (fmt:check = check only)
bun run typecheck          # tsc over the app
bun run typecheck:worker   # tsc over worker/ (own tsconfig + workers-types)
bun run typecheck:test     # tsc over unit tests (tsconfig.test.json)
bun run test       # bun test over src + worker/ (pure logic only)
bun run test:e2e   # playwright, chromium
bun run test:e2e:serial    # --workers=1, for flake hunting
bun run release    # cut a release (the ONLY way to bump the version)
bun run release:ship       # checkout main + pull -> release -> push --follow-tags -> publish
bun run db:migrate:local   # D1 migrations (:remote = prod, run before first deploy)
bun run effect:src         # print (fetch on first use) the Effect v4 source path
bun run effect:src:update  # refresh that cache to latest
```

`--workers=2` is the clean-signal full local run. **e2e does not run in CI**, so nothing upstream catches a skipped run.

## Before you design

**New feature or design decision? Stop and grill it first. This is a MUST, not a nicety.**

It applies to a new plugin, a new route, a new plugin seam, a new `Node` field or wire-schema change, a new side-collection, or any behavior whose _why_ an ADR would carry. Before writing code, do both, in order:

1. **Read the ADRs that already constrain the area.** `docs/adr/` holds 58 of them, and they carry the constraints that PRs keep breaking. This file cites them by number, but the content is in the ADR. An agent that never opens one designs blind against invariants it cannot see.
2. **Run `/grill-with-docs`.** A relentless interview that sharpens the decision and records new ADRs via `/domain-modeling` as they crystallise. If your harness cannot invoke it, run the behavior by hand: hold the design against each constraining ADR from step 1 and stress-test it before committing to an approach.

This holds for every contributor, human or agent. Skipping it is how invariants get rediscovered the expensive way.

### Touching this? Read this first

This table is a shortcut, not the full set. `docs/adr/` is authoritative; absence from this table means nothing.

| Surface                                                | ADR                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Plugin seams, adding a plugin                          | 0001, 0031, and [`docs/plugins.md`](./docs/plugins.md) |
| Tree store, per-node rendering                         | 0004                                                   |
| Rich links, the source-offset caret                    | 0005, 0016                                             |
| React token widgets                                    | 0006                                                   |
| Tag colors                                             | 0007                                                   |
| Per-user DO sync, SPA/no-SSR                           | 0008                                                   |
| Structural write atomicity                             | 0009, 0010                                             |
| Auth gate, Google sign-in, verification                | 0011                                                   |
| Effect (replaces errore), sync socket, schema language | 0012, 0013, 0021, 0053                                 |
| Worker to DO trust boundary                            | 0014                                                   |
| Protected nodes                                        | 0015                                                   |
| Markdown export / paste                                | 0017, 0044                                             |
| Node multi-selection                                   | 0018, 0020                                             |
| Virtualized rendering                                  | 0019                                                   |
| Mirrors                                                | 0022                                                   |
| DO storage stays native                                | 0023                                                   |
| Inline emphasis, highlights, spoilers                  | 0025, 0035, 0043                                       |
| MCP server + tools                                     | 0026, 0027, 0028                                       |
| Touch targets, reading size, the bullet dot            | 0029                                                   |
| Mobile actions bar                                     | 0030                                                   |
| Node links + backlinks                                 | 0032                                                   |
| Spotlight focus mode                                   | 0033                                                   |
| Cmd+K command center                                   | 0034                                                   |
| Desktop selection toolbar                              | 0036                                                   |
| OPML import/export                                     | 0037                                                   |
| Date token, go-to-date, date mentions, chip voice      | 0038, 0055, 0056, 0057                                 |
| Plugin async/Effect seam                               | 0039                                                   |
| Effect source via opensrc                              | 0040                                                   |
| Daily notes: seeding, calendar hierarchy, week strip   | 0041, 0052, 0054                                       |
| Paragraph node kind                                    | 0045                                                   |
| Changelog + release versioning                         | 0046                                                   |
| Query filter grammar, saved filters                    | 0047, 0048                                             |
| Quick-add capture                                      | 0049                                                   |
| Account deletion                                       | 0051                                                   |
| Lunora sync (experimental, flag-gated)                 | 0058                                                   |
| Backspace joins into the previous row                  | 0059                                                   |

## Gotchas

### Data and sync

- **Structural edits go through `runStructural`; field edits do not.** Any tree-shape change (insert/indent/outdent/move/reparent/remove, undo restore, daily get-or-create) must land as ONE batch with the optimistic overlay held until its echo. Both halves are load-bearing; dropping either reintroduces sibling-chain corruption. Field edits (`setText`, `setKind`, `setIsTask`, toggles) stay direct PATCH and must never await an echo, because that is the keystroke path. Wrap at the call sites, not inside `mutations.ts`. ADR 0009.
- **A new `Node` field touches seven places.** `src/data/wire-schema.ts`, `src/data/schema.ts`, `makeNode()`, `withNodeDefaults` in `collection.ts`, a DO `ADD COLUMN` migration, `e2e/fixtures.ts`, and the R2 snapshot boundary in `worker/backup.ts`. Miss the fixtures and inbound-frame decode rejects every snapshot, producing an empty outline. This shipped broken twice, with `origin` and with `kind`.
- **A new side-collection must be added to `KV_COLLECTIONS` in `worker/index.ts`.** The e2e kv mock accepts any collection name, so only a live Worker catches the miss. Shipped broken once, with `saved-queries`.
- **Build nodes with `makeNode()`. No schema defaults.** A default makes the field optional in the encoded type and fights TanStack DB's schema-typed collection overload. ADR 0003.
- **Side-collection reads use `subscribeChanges` + `useSyncExternalStore`, never `useLiveQuery`.** `useLiveQuery` hard-fails the `/` prerender. A zero-row collection emits no change event, so readiness rides `toArrayWhenReady()`.
- **The tree index is mutated in place and notifies synchronously.** A mutation that reads `childrenOf` _after_ an `update()` sees post-mutation state. Read sibling state before mutating.
- **Multi-node mutations rebuild the index from the live collection between each step.** Looping over a stale snapshot tears the sibling chain when the operated nodes are siblings of each other.
- **Rows read the tree store per node. Never pass `node` or `index` as a prop.** ADR 0004.
- **Event-time reads go through getters** (`getTreeIndex()`, `getViewRootId()`, `getViewIsHidden()`, `getViewFilter()`); render reads use props. Never the reverse. View-state writes happen in effects, not during render, so the editor stays React-Compiler-eligible.
- **There is no client-side data migration.** localStorage is browser-scoped but accounts are per-user, so a localStorage import leaks one browser's outline into every account signed in there. A returning owner's pre-DO data is carried over server-side instead.

### Worker, auth, and the trust boundary

- **Never key the DO off the email.** A DO name is permanent, so an email change would orphan the whole outline. Route through `resolveUserId`. The single exception is the owner-continuity bridge to the constant `'default'` DO.
- **Never relax the `/api` session check to trust a client-supplied id.**
- **Never relax the SSRF guard in `worker/unfurl.ts`, and revalidate every redirect hop.** It is an authenticated fetch surface.
- **`createAuth(env, requestOrigin)` is built per request, never a module singleton.** The D1 binding only exists inside `fetch`.
- **Google is `disableSignUp: true`, never `disableImplicitSignUp`.** A client-supplied `requestSignUp: true` waives the latter, which is an invite bypass. Related dead end: the deprecated `requireLocalEmailVerified: false`. ADR 0011.
- **Signup gates fail closed.** `SIGNUP_OPEN` must be the exact literal `"true"`. Admin routes return 404, not 401.
- **All transactional email goes through `worker/email.ts`**, never `env.EMAIL.send()` directly. Sends are parked on `ctx.waitUntil` so response timing stays uniform and cannot be used to enumerate accounts.
- **DO write atomicity is `ctx.storage.transactionSync()`, not Effect.** Row writes, seq bump, and changelog go in one transaction; frames broadcast only after durable commit. Batches over 500 ops chunk into consecutive-seq changelog rows, preserving op order so every frame prefix stays chain-valid. ADR 0014.
- **Request bodies decode against Effect Schema.** No unchecked `as` casts on bodies or inbound frames, and no Schema `.default()`s papering over a bad body. The wire types are derived from the schemas, so validator and type cannot drift.
- **The `_shell.html` to `index.html` copy is load-bearing.** SPA mode emits `_shell.html`, but Static Assets serves `index.html`.
- **The Worker is typechecked separately and lives in `worker/`** so its runtime types do not clash with the app's DOM lib. Don't move it under `src/`.
- **Never run code that touches `nodesCollection` during a server or render pass.** The app is a pure static SPA; the DO holds the data. ADR 0008.

### Billing

No ADR covers this yet; these rules live only here.

- **Entitlement reads never call Stripe.** `getPlan(userId, env)` is one D1 query on `referenceId = user.id` (never the email), `status IN ('active','trialing')`. Free tier is no row. An operator-comped user is a hand-inserted active row with no Stripe ids.
- **The founding seat cap stays in `getCheckoutSessionParams`, at checkout-creation time.** Don't move it into an async `plans` fn: webhooks and `subscription.list()` resolve plans from that same list, so withholding the plan would break state updates for existing founding subscribers.
- **Prices are referenced by lookup key**, not price-id env vars. Dashboard prices in test and live mode must carry them. `scripts/stripe-setup.ts` is idempotent and warns rather than edits on a mismatch, because Stripe prices are immutable.

### Editor

- **A node renders in three places with three separate keymaps.** The list bullet (`OutlineRow` + `useBulletKeymap`), the zoomed page title (`ZoomedTitle`'s own inline `useHotkeys`), and quick-add's `MiniNodeEditor`. A new key, caret interaction, or decoration works in one and silently no-ops in the others until added to each. This is the single most repeated bug in this repo's history. Delegated pointer handlers, the `/` palette, and the caret menus already reach all three; keymaps and slots do not.
- **`el.textContent` is not the source.** Folding tokens (links, emphasis, code, highlight, spoiler) render `data-src` atoms, so reading text means `readSource(el)`, and caret offsets are SOURCE offsets via `getCaretOffset`/`setCaretOffset`. This applies to `onInput`, paste, copy/cut, and the slash and tag menus.
- **contentEditable text sync is manual, not React-controlled.** Stored text writes to the DOM only when it differs, to avoid clobbering the caret. Don't convert it to controlled text.
- **`OutlineEditor` carries `"use no memo"`.** The React Compiler would memoize `getVirtualItems()` on the stable virtualizer instance and freeze the windowed list on scroll. `SwitcherDialog` carries it for the same reason. Don't remove either; don't add the directive elsewhere without the same concrete cause.
- **Don't remove the hand-tuned `memo`/`useMemo` in the editor** to let the compiler handle it. They gate the contentEditable hot path and removing them is a behavior-risky refactor the compiler does not make safe.
- **The visible-neighbor walk must mirror render visibility** — skip completed when hidden, and walk the same filtered rows when a `?q=` filter is active. Otherwise arrow-key focus silently no-ops.
- **The `refs` registry maps node id to contentEditable span, and the zoomed title registers under `rootId`.** Focus, pending-focus, and the zoom morph all depend on that.
- **Assert nesting via `data-parent-id` and `data-depth`, never DOM containment.** The windowed list is flat; rows are not nested.

### Plugins

- **Token `render` output must be byte-stable and allocation-light.** The `decorate` cache compares strings, and it runs per keystroke.
- **Never hand the core raw HTML.** Return `El` or `WidgetEl`.
- **A plain `El` freezes when its label depends on another node.** The decorate cache is keyed on the source string, which does not change when the _target_ changes. Use a widget that subscribes.
- **Plugin UI comes from `src/plugins/kit.ts`.** Importing `@/components/ui/*` from a plugin is an oxlint error. There is no plugin `styles` seam; style with Tailwind utilities on your `El`.
- **When two token markers share a leading character, the double-char one needs the lower precedence number** so it wins on overlap.
- **Filter operators throw at load on a duplicate `(key, value)` claim.** A key may have many owners; a pair may not.

### Effect

Effect's typed-error channel is the error model. errore is fully removed; don't reintroduce it. ADR 0012.

Effect v4 is post-training-cutoff for most models. **Read the real source before writing Effect code**, never `node_modules/effect/`:

```sh
bunx opensrc path Effect-TS/effect-smol
```

Read its `AGENTS.md` and `.patterns/` first. Search it with `grep -rn`/Read, **not** fff or codegraph — the cache lives outside the git tree, and both tools are scoped to it. Never import from the fetched copy; app code imports `effect` from npm as normal. The same tool reads any dependency's source. ADR 0040.

`kv-api.ts` must keep throwing (TanStack DB signals mutation failure by throwing, which triggers optimistic rollback), but the throw is Effect-backed via `runPromise`, not a hand-rolled fetch.

### Tests

- **`bun test` is pure logic only.** Behavior and integration stay in Playwright; don't unit-test the contentEditable/caret/collection/DO path, you would only mock the world. Two principled exceptions exist: the sync socket's reconnect policy (an injectable service, ADR 0013) and the Worker wire schemas (pure decode, unreachable from e2e, ADR 0014).
- **e2e runs on its own Vite server on port 3210 and never reuses an existing one.** Anything already answering there is a zombie run or a sibling worktree serving different source. Kill it, or set `E2E_PORT`.
- **Caret in a contentEditable test: set the Selection range directly.** `Home`/`End`/arrows are unreliable in macOS Chromium, and `.click()` lands past the bullet text. Working helpers: `e2e/enter-split.spec.ts`.
- **`toHaveText` normalizes whitespace.** Prefer space-free fixture text, or `allTextContents()` for exact comparison.
- **Adding an MCP tool means updating the ordered tool-name list in `worker/mcp.test.ts`.**
- **Perf guards assert a countable invariant, never a wall clock.** Registration counts and mounted-row counts read identically on a laptop and a throttled CI box; timings do not. Add one only when the regression has a countable signature. Templates: `e2e/zoom-perf.spec.ts`, `e2e/virtualized-windowing.spec.ts`.

### Build and release

- **`src/routeTree.gen.ts` is generated and committed in the generator's own format.** Never hand-edit, never reformat. Both static gates ignore it, which is what keeps a dev-server boot from dirtying the worktree.
- **Every PR adds a changeset fragment; CI fails without one.** `bunx changeset`, or `bunx changeset --empty` when the PR genuinely is not news. The gate wants a decision, not an invented entry.
- **`bun run release` is the only way to bump the version.** Running `changeset version` directly deletes the fragments before they are archived, and the build then fails. That failure is the process, not a bug to work around. ADR 0046.
- **Semver here is communicative, not contractual.** Nobody can pin Dotflowy. Major means a reader has to do something; minor means a new capability; patch means it got better.
- **After `bun add` of a React-importing package while the dev server runs**, an "Invalid hook call / multiple copies of React" crash is a stale Vite dep-optimize cache. Stop the server, `rm -rf node_modules/.vite`, restart.

## Working agreements

- **Repo reality is the source of truth for docs.** If `AGENTS.md` or `README.md` becomes false about an objective fact (paths, commands, tooling), fix it in the same change. Ask before changing policy, philosophy, or positioning.
- **Run the app before declaring an observable change done.** Green gates are necessary, not sufficient; typecheck, lint, and tests can all pass while the feature does the wrong thing on screen. The `/verify` skill does exactly this. Skip only for changes with no runtime surface.
- **PR descriptions use `/ft-create-concise-pr`.** Every PR in this repo follows that template, so reviewers get one skimmable shape. Re-run its Update pass after review changes rather than letting the description drift.
- **Non-trivial PRs run `/code-review` before ready.** Add `/security-review` when the diff touches auth, the SSRF surface, the Worker/DO trust boundary, or the signup gate.
- **A decision earns an ADR** when it is hard to reverse, surprising without context, and the result of a real trade-off. If the code already makes the call obvious, the code is the doc. When a decision changes, edit its ADR in place or mark it superseded.
- **Multi-session feature work hands state forward in `HANDOFF.md`**, committed on the branch and deleted in the shipping PR. It must never reach `main`. Transient build-coordination state only; decisions belong in ADRs.

## Tooling

- **Search:** use fff for file search and grep in the git tree. Use codegraph (`codegraph_*`) for structural questions — what calls what, where a symbol is defined, what would break. Trust codegraph results; they come from a full AST parse, so re-verifying with grep is slower and less accurate. Neither reaches `~/.opensrc/`.
- **Skills:** run `bunx @tanstack/intent@latest list` before substantial work, and load the most specific local skill for the package you are changing.
- **Occasional audits, not gates:** `npx -y react-doctor@latest . --verbose` (its editor false-positives are known and accepted), Playwright `--trace on`, and the DEV-only `window.__hotkeyManager` handle for live hotkey registration counts.
- **Capture repeated incantations** in a `package.json` script or a config file. Reach for `scripts/*.ts` only when there is no config home.

## Preferences

Cam's, learned in prior sessions. Not derivable from the code.

- **Implementation calls, once the approach is agreed:** pick the best reasonable option and proceed rather than stopping to ask. Favor robustness and best practices, balanced against not over-optimizing low-value work. This does **not** waive the design interview above. Grilling settles the approach; this governs the choices inside it. Ask before switching checkouts if the target worktree is unclear.
- **Stack direction:** deepen Effect and XState where they genuinely fit.
- **Landing site** (separate `landing/` package, dotflowy.com): Geist only, no mono. Accents match the app palette; no colors the app does not use. Feature bullets stay vertical on desktop. Keep "Workflowy alternative" out of the H1 and footer brand row — meta description and quiet body copy instead. Import copy should mention Workflowy alongside OPML.
- **Icons:** prefer free MIT Hugeicons (`@hugeicons/react` + `@hugeicons/core-free-icons`), default stroke.
- **Lunora sync stays opt-in** behind a user-facing beta flag; no production cutover while it is alpha. User-facing copy must not name Lunora — frame it as an experimental sync option, and disclose that turning it off returns to the last classic snapshot.
- **Implementation subagents in Cursor:** prefer Cursor Auto or Cursor Grok 4.5.

## Experimental: Lunora sync

Flag-gated (`dotflowy:flag:lunora-sync`, synced `account-prefs`/`lunora-beta`, Worker `LUNORA_OUTLINE`). Classic per-user DO remains the default. ADR 0058. Known traps:

- Vite proxies for `/api` and `/_lunora` need explicit `ws: true`; the string shorthand does not upgrade WebSockets.
- Cutover is one-way. Flag off reloads the classic DO frozen at migrate; Lunora-era edits do not write back.
- Migration must finish KV independently of nodes. Daily identity lives in `daily-index` KV, so a nodes-only migrate leaves Daily empty. Completion is Lunora `migrateState` (`nodesAt`/`kvAt`); stamp `nodesAt` only after the full classic node import.
- Every mutator patch/delete/get must pass `expectedTable`. An unscoped id lookup builds `UNION ALL` across shard tables and hits Workerd SQLite's compound-SELECT limit.
- Remigrate is insert-missing only and will not rewrite `parentId`s, so orphaned daily nodes need a reattach heal.
