# Dotflowy

Dotflowy is an outliner: nested bullets, per-user sync, and a plugin-extended editor. It is a React SPA with no SSR, on Cloudflare Workers. Each user's outline lives in its own Durable Object.

Structure, data model, and the backend-swap path: [`docs/architecture.md`](./docs/architecture.md). Setup and local dev: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

This file holds the gotchas. A gotcha is a trap that you cannot see in the code and that stays silent when you break it. Everything else in this repo is behind a pointer.

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
bun run check:docs         # every doc pointer and ADR citation resolves
bun run release    # cut a release (the ONLY way to bump the version)
bun run release:ship       # checkout main + pull -> release -> push --follow-tags -> publish
bun run db:migrate:local   # D1 migrations (:remote = prod, run before first deploy)
bun run effect:src         # print (fetch on first use) the Effect v4 source path
bun run effect:src:update  # refresh that cache to latest
```

`--workers=2` is the clean-signal full local run. **e2e does not run in CI.** Nothing upstream catches a run that you skip.

## Before you design

**New feature or design decision? Stop and grill it first. This is a MUST, not a nicety.**

This rule applies to:

- a new plugin
- a new route
- a new plugin seam
- a new `Node` field or wire-schema change
- a new side-collection
- any behavior whose _why_ an ADR must carry

Before you write code, do both steps, in this order:

1. **Read the ADRs that constrain the area.** `docs/adr/` holds 58 of them. They carry the constraints that PRs keep breaking. This file cites them by number, but the content is in the ADR itself. An agent that opens none of them designs blind against invariants it cannot see.
2. **Stop and ask the user to run `/grill-with-docs`.** An agent cannot fire this skill. It is user-invoked only. The interview sharpens the decision, and it records new ADRs through `/domain-modeling`, which an agent _can_ invoke. If the user waives the interview, do the work by hand. Hold the design against each ADR from step 1. Then stress-test the design before you commit to an approach.

This rule holds for every contributor, human or agent. If you skip it, someone rediscovers the invariants the expensive way.

Every slash command in this file carries its invocation mode where it appears. An agent can invoke `/domain-modeling`, `/code-review`, `/security-review`, and `/ft-create-concise-pr`. Only the user can invoke `/grill-with-docs`.

### Touching this? Read this first

`docs/adr/` filenames name their own surface, so the directory is the index. Run `ls docs/adr/` and read the ADRs that match what you are about to touch.

These six entries are the exceptions. In each one, the surface you search for does not appear in the filename:

| Surface                                                | ADR                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Plugin seams, adding a plugin                          | 0001, 0031, and [`docs/plugins.md`](./docs/plugins.md) |
| Structural write atomicity, and why field edits differ | 0009, 0010                                             |
| Auth gate, Google sign-in, email verification          | 0011                                                   |
| Effect: errore removal, sync socket, schemas, fiber    | 0012, 0013, 0021, 0053                                 |
| Touch targets, reading size, and the bullet dot        | 0029                                                   |
| Lunora sync (experimental, flag-gated)                 | 0058                                                   |

## Gotchas

### Data and sync

- **Send structural edits through `runStructural`. Send field edits direct.** A tree-shape change must land as ONE batch. Hold the optimistic overlay until its echo. Both halves are load-bearing. If you drop either one, the sibling chain corrupts again. Field edits (`setText`, `setKind`, `setIsTask`, toggles) stay a direct PATCH. A field edit must never wait for an echo, because that is the keystroke path. Wrap at the call sites, not inside `mutations.ts`. The tree-shape changes are insert, indent, outdent, move, reparent, remove, undo restore, and daily get-or-create. ADR 0009.
- **A new `Node` field touches seven places.** Add the field to each one:
  1. `src/data/wire-schema.ts`
  2. `src/data/schema.ts`
  3. `makeNode()`
  4. `withNodeDefaults` in `collection.ts`
  5. a DO `ADD COLUMN` migration
  6. `e2e/fixtures.ts`
  7. the R2 snapshot boundary in `worker/backup.ts`

  If you miss the fixtures, inbound-frame decode rejects every snapshot. The outline then loads empty. This shipped broken twice, with `origin` and with `kind`.

- **Add a new side-collection to `KV_COLLECTIONS` in `worker/index.ts`.** The e2e kv mock accepts any collection name, so only a live Worker catches the miss. This shipped broken once, with `saved-queries`.
- **Build nodes with `makeNode()`. Write no schema defaults.** A default makes the field optional in the encoded type. It also fights the schema-typed collection overload in TanStack DB. ADR 0003.
- **Read side-collections with `subscribeChanges` and `useSyncExternalStore`, never `useLiveQuery`.** `useLiveQuery` hard-fails the `/` prerender. A collection with zero rows emits no change event, so readiness rides `toArrayWhenReady()`.
- **The tree index mutates in place and notifies synchronously.** A mutation that reads `childrenOf` _after_ an `update()` sees post-mutation state. Read sibling state before you mutate.
- **Multi-node mutations rebuild the index from the live collection between each step.** A loop over a stale snapshot tears the sibling chain when the operated nodes are siblings of each other.
- **Rows read the tree store per node. Never pass `node` or `index` as a prop.** ADR 0004.
- **Read event-time values through the getters.** The getters are `getTreeIndex()`, `getViewRootId()`, `getViewIsHidden()`, and `getViewFilter()`. Render reads use props instead. Never swap the two. Write view state in effects, never during render, so the editor stays React-Compiler-eligible.
- **There is no client-side data migration.** localStorage is browser-scoped, but accounts are per-user. A localStorage import therefore leaks one browser's outline into every account that signs in there. The Worker carries a returning owner's pre-DO data over server-side instead.

### Worker, auth, and the trust boundary

- **Never key the DO off the email.** A DO name is permanent, so an email change orphans the whole outline. Route through `resolveUserId`. The one exception is the owner-continuity bridge to the constant `'default'` DO.
- **Never relax the `/api` session check to trust a client-supplied id.**
- **Never relax the SSRF guard in `worker/unfurl.ts`. Revalidate every redirect hop.** It is an authenticated fetch surface.
- **Build `createAuth(env, requestOrigin)` per request, never as a module singleton.** The D1 binding exists only inside `fetch`.
- **Google is `disableSignUp: true`, never `disableImplicitSignUp`.** A client can waive the second one with `requestSignUp: true`, which bypasses the invite gate. The deprecated `requireLocalEmailVerified: false` is a related dead end. ADR 0011.
- **Signup gates fail closed.** `SIGNUP_OPEN` must be the exact literal `"true"`. Admin routes return 404, not 401.
- **Send all transactional email through `worker/email.ts`**, never through `env.EMAIL.send()` directly. Park sends on `ctx.waitUntil` so response timing stays uniform. Uniform timing is what stops an attacker from enumerating accounts.
- **DO write atomicity is `ctx.storage.transactionSync()`, not Effect.** Row writes, the seq bump, and the changelog go in one transaction. Frames broadcast only after a durable commit. A batch over 500 ops chunks into consecutive-seq changelog rows. The chunking preserves op order, so every frame prefix stays chain-valid. ADR 0014.
- **Decode request bodies against Effect Schema.** Write no unchecked `as` casts on bodies or inbound frames. Add no Schema `.default()` that papers over a bad body. The wire types derive from the schemas, so the validator and the type cannot drift.
- **The `_shell.html` to `index.html` copy is load-bearing.** SPA mode emits `_shell.html`, but Static Assets serves `index.html`.
- **The Worker is typechecked separately and lives in `worker/`.** That keeps its runtime types clear of the DOM lib in the app. Do not move it under `src/`.
- **Never run code that touches `nodesCollection` during a server or render pass.** The app is a pure static SPA. The DO holds the data. ADR 0008.

### Billing

No ADR covers this area yet. These rules live only here.

- **Entitlement reads never call Stripe.** `getPlan(userId, env)` is one D1 query on `referenceId = user.id`, never on the email, with `status IN ('active','trialing')`. The free tier is no row at all. An operator-comped user is a hand-inserted active row with no Stripe ids.
- **Keep the founding seat cap in `getCheckoutSessionParams`, at checkout-creation time.** Do not move it into an async `plans` function. Webhooks and `subscription.list()` resolve plans from that same list. If the list withholds the plan, state updates break for existing founding subscribers.
- **Reference prices by lookup key, not by price-id env vars.** Dashboard prices in test mode and live mode must both carry them. `scripts/stripe-setup.ts` is idempotent. On a mismatch it warns and does not edit, because Stripe prices are immutable.

### Editor

- **A node renders in three places, with three separate keymaps.** They are the list bullet (`OutlineRow` with `useBulletKeymap`), the zoomed page title (the inline `useHotkeys` inside `ZoomedTitle`), and the `MiniNodeEditor` in quick-add. A new key, caret interaction, or decoration works in one path and silently no-ops in the other two until you add it to each. This is the most repeated bug in the history of this repo. Delegated pointer handlers, the `/` palette, and the caret menus already reach all three. Keymaps and slots do not.
- **`el.textContent` is not the source.** Folding tokens render `data-src` atoms, so read text with `readSource(el)`. Folding tokens are links, emphasis, code, highlight, and spoiler. Caret offsets are SOURCE offsets through `getCaretOffset` and `setCaretOffset`. This applies to `onInput`, paste, copy, cut, and the slash and tag menus.
- **contentEditable text sync is manual, not React-controlled.** Stored text writes to the DOM only when it differs, which avoids clobbering the caret. Do not convert it to controlled text.
- **`OutlineEditor` carries `"use no memo"`.** Without it the React Compiler memoizes `getVirtualItems()` on the stable virtualizer instance and freezes the windowed list on scroll. `SwitcherDialog` carries it for the same reason. Remove neither. Add the directive elsewhere only for the same concrete cause.
- **Keep the hand-tuned `memo` and `useMemo` in the editor.** Do not remove them so the compiler can take over. They gate the contentEditable hot path, and removing them is a behavior-risky refactor that the compiler does not make safe.
- **The visible-neighbor walk must mirror render visibility.** Skip completed rows when they are hidden. Walk the same filtered rows when a `?q=` filter is active. If the walk does not mirror the render, arrow-key focus silently no-ops.
- **The `refs` registry maps a node id to its contentEditable span, and the zoomed title registers under `rootId`.** Focus, pending-focus, and the zoom morph all depend on that.
- **Assert nesting through `data-parent-id` and `data-depth`, never through DOM containment.** The windowed list is flat. Rows are not nested.
- **`rootId` is route-owned.** `routes/index.tsx` gives `null`, and `routes/$nodeId.tsx` gives `nodeId`. Never add editor-local zoom state. The editor remounts per zoom view through its `key={nodeId}`, and the mount-only effects depend on that. No ADR covers this rule.

### Plugins

- **Token `render` output must be byte-stable and allocation-light.** The `decorate` cache compares strings, and it runs on every keystroke.
- **Never hand the core raw HTML.** Return `El` or `WidgetEl`.
- **A plain `El` freezes when its label depends on another node.** The decorate cache keys on the source string, which does not change when the _target_ changes. Use a widget that subscribes instead.
- **Take plugin UI from `src/plugins/kit.ts`.** An import of `@/components/ui/*` from a plugin is an oxlint error. There is no plugin `styles` seam. Style with Tailwind utilities on your `El`.
- **When two token markers share a leading character, give the double-char marker the lower precedence number.** It then wins on overlap.
- **Filter operators throw at load on a duplicate `(key, value)` claim.** A key can have many owners. A pair cannot.

### Effect

The typed-error channel in Effect is the error model. errore is fully removed. Do not reintroduce it. ADR 0012.

Effect v4 is post-training-cutoff for most models. **Read the real source before you write Effect code.** Never read `node_modules/effect/`:

```sh
bunx opensrc path Effect-TS/effect-smol
```

Read its `AGENTS.md` and `.patterns/` first. Search it with `grep -rn` or Read, **not** with fff or codegraph. The cache lives outside the git tree, and both tools are scoped to that tree.

Never import from the fetched copy. App code imports `effect` from npm as normal. The same tool reads the source of any dependency. ADR 0040.

`kv-api.ts` must keep throwing. TanStack DB signals a failed mutation by throwing, which triggers optimistic rollback. The throw is Effect-backed through `runPromise`, not a hand-rolled fetch.

### Tests

- **`bun test` is for pure logic only.** Behavior and integration stay in Playwright. Do not unit-test the contentEditable, caret, collection, or DO path, because you can only mock the world. Two principled exceptions exist: the reconnect policy of the sync socket (an injectable service, ADR 0013) and the Worker wire schemas (pure decode, unreachable from e2e, ADR 0014).
- **e2e runs on its own Vite server on port 3210 and never reuses an existing one.** Anything already answering there is a zombie run, or a sibling worktree that serves different source. Kill it, or set `E2E_PORT`.
- **For a caret in a contentEditable test, set the Selection range directly.** `Home`, `End`, and the arrow keys are unreliable in macOS Chromium. `.click()` lands past the bullet text. Working helpers: `e2e/enter-split.spec.ts`.
- **`toHaveText` normalizes whitespace.** Prefer fixture text with no spaces, or use `allTextContents()` for an exact comparison.
- **When you add an MCP tool, update the ordered tool-name list in `worker/mcp.test.ts`.**
- **A perf guard asserts a countable invariant, never a wall clock.** Registration counts and mounted-row counts read the same on a laptop and on a throttled CI box. Timings do not. Add a guard only when the regression has a countable signature. Templates: `e2e/zoom-perf.spec.ts` and `e2e/virtualized-windowing.spec.ts`.

### Build and release

- **`src/routeTree.gen.ts` is generated, and committed in the format of its generator.** Never hand-edit it. Never reformat it. Both static gates ignore it, which is what keeps a dev-server boot from dirtying the worktree.
- **Every PR adds a changeset fragment. CI fails without one.** Run `bunx changeset`, or `bunx changeset --empty` when the PR is genuinely not news. The gate wants a decision, not an invented entry.
- **`bun run release` is the only way to bump the version.** A direct `changeset version` deletes the fragments before they are archived, and the build then fails. That failure is the process. Do not work around it. ADR 0046.
- **Semver here is communicative, not contractual.** Nobody can pin Dotflowy. Major means a reader must do something. Minor means a new capability. Patch means it got better.
- **A React-importing package can crash the running dev server after `bun add`.** The error is "Invalid hook call / multiple copies of React", and the cause is a stale Vite dep-optimize cache. Stop the server, run `rm -rf node_modules/.vite`, then restart.
- **The Codex app rewrites `.codex/environments/environment.toml`** whenever the environment is edited through its settings pane, and it drops every comment in the file. Do not put load-bearing explanation there.

## Working agreements

- **Repo reality is the source of truth for the docs.** An objective fact is a path, a command, or the tooling. If `AGENTS.md` or `README.md` becomes false about one, correct it in the same change. Ask first before you change policy, philosophy, or positioning.
- **Run the app before you call an observable change done.** Green gates are necessary but not sufficient. Typecheck, lint, and tests can all pass while the feature does the wrong thing on screen. Drive the change in `bun run cf:dev`, or exercise it through an e2e spec. Skip this step only for a change with no runtime surface.
- **Write PR descriptions with `/ft-create-concise-pr`** (agent-invocable). Every PR in this repo follows that template, so reviewers get one skimmable shape. After review changes, run its Update pass rather than letting the description drift.
- **Run `/code-review` on a non-trivial PR before it is ready** (agent-invocable). Add `/security-review` when the diff touches auth, the SSRF surface, the Worker-to-DO trust boundary, or the signup gate.
- **A decision earns an ADR** when it is hard to reverse, surprising without context, and the result of a real trade-off. If the code already makes the call obvious, the code is the doc. When a decision changes, edit its ADR in place, or mark it superseded.
- **Multi-session feature work hands state forward in `HANDOFF.md`.** Commit it on the branch and delete it in the shipping PR. It must never reach `main`. Put transient build-coordination state in it. Decisions belong in ADRs.

## Tooling

The three blocks below are written by their own tools. The `:start` and `:end`
markers are how each tool finds its block to replace. Never hand-edit inside
them, and never drop the markers: without them the next run appends a duplicate.
Neither fff nor codegraph reaches `~/.opensrc/`.

- **Occasional audits, not gates:** `npx -y react-doctor@latest . --verbose`, whose editor false-positives are known and accepted. Also Playwright `--trace on`, and the DEV-only `window.__hotkeyManager` handle for live hotkey registration counts.
- **Capture a repeated incantation** in a `package.json` script or a config file. Reach for `scripts/*.ts` only when there is no config home.

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

| Question                                      | Tool                |
| --------------------------------------------- | ------------------- |
| "Where is X defined?" / "Find symbol named X" | `codegraph_search`  |
| "What calls function Y?"                      | `codegraph_callers` |
| "What does Y call?"                           | `codegraph_callees` |
| "What would break if I changed Z?"            | `codegraph_impact`  |
| "Show me Y's signature / source / docstring"  | `codegraph_node`    |
| "Give me focused context for a task/area"     | `codegraph_context` |
| "Survey an unfamiliar module/topic"           | `codegraph_explore` |
| "What files exist under path/"                | `codegraph_files`   |
| "Is the index healthy?"                       | `codegraph_status`  |

### Rules of thumb

- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **`codegraph_explore` is the heavy hitter** for unfamiliar areas — it returns full source from all relevant files in one call, but is token-heavy. If your harness supports parallel subagents (e.g., Claude Code's Task tool), spawn one for explore-class questions to keep main session context clean.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: _"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"_
<!-- codegraph:end -->

<!-- fff:start -->

For any file search or grep in the current git-indexed directory, use fff tools.
<!-- fff:end -->

## Preferences

These are Cam's preferences, learned in earlier sessions. You cannot derive them from the code.

- **Implementation calls, once the approach is agreed:** pick the best reasonable option and proceed. Do not stop to ask. Favor robustness and best practices, balanced against not over-optimizing low-value work. This does **not** waive the design interview above. The grilling settles the approach. This preference governs the choices inside it. If the target worktree is unclear, ask before you switch checkouts.
- **Local dev server:** use `bun run cf:dev` on port 8787. `bun run dev` on port 3000 has a broken database on Cam's machine.
- **Stack direction:** deepen Effect and XState where they genuinely fit.
- **Landing site** (the separate `landing/` package, at dotflowy.com): Geist only, no mono. Accents match the app palette. Introduce no color that the app does not use. Feature bullets stay vertical on desktop. Keep "Workflowy alternative" out of the H1 and the footer brand row. Put it in the meta description and quiet body copy instead. Import copy mentions Workflowy next to OPML.
- **Icons:** prefer the free MIT Hugeicons (`@hugeicons/react` and `@hugeicons/core-free-icons`), at default stroke.
- **Lunora sync stays opt-in** behind a user-facing beta flag. Do not cut production over while it is alpha. User-facing copy must not name Lunora. Frame it as an experimental sync option. Disclose that turning it off returns the user to the last classic snapshot.
- **Implementation subagents in Cursor:** prefer Cursor Auto or Cursor Grok 4.5.

## Experimental: Lunora sync

Lunora sync is flag-gated through `dotflowy:flag:lunora-sync`, the synced `account-prefs`/`lunora-beta` value, and the Worker binding `LUNORA_OUTLINE`. The classic per-user DO remains the default. ADR 0058.

Known traps:

- The Vite proxies for `/api` and `/_lunora` need an explicit `ws: true`. The string shorthand does not upgrade WebSockets.
- Cutover is one-way. With the flag off, the app reloads the classic DO frozen at migrate time. Lunora-era edits do not write back.
- Migration must finish KV independently of nodes. Daily identity lives in `daily-index` KV, so a nodes-only migrate leaves Daily empty. Completion is the Lunora `migrateState` pair, `nodesAt` and `kvAt`. Stamp `nodesAt` only after the full classic node import.
- Every mutator patch, delete, and get must pass `expectedTable`. An unscoped id lookup builds `UNION ALL` across the shard tables and hits the compound-SELECT limit in Workerd SQLite.
- Remigrate inserts missing rows only. It does not rewrite any `parentId`, so orphaned daily nodes need a reattach heal.
- `nodesCollection.toArray` is `[]` while the flag is on, and it never errors. Read live nodes through `getLiveNodes()`. A direct read builds an empty tree index, which fails `mirrorNode` and turns a captured undo point into delete-everything. oxlint bans that import in `src/plugins/**` and `src/components/**`, minus three files that write to it.
