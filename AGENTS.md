<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# Project Guidance

Guidance for coding agents working in this repo. `CLAUDE.md` is a symlink to this file.

`README.md` covers the data model, persistence, backend-swap path, and project layout — read it first and don't duplicate it here. This file is the non-obvious operational stuff: commands, gotchas, and the one rule per feature, each pointing at its ADR for the *why*.

## Documentation Freshness

Repo reality is the source of truth. If `AGENTS.md` or `README.md` becomes false about an objective fact (repo structure, paths, commands, tooling, workflow constraints proven by the repo), fix it in the same change.

- Update `AGENTS.md` for stale agent-facing facts, `README.md` for stale human-facing purpose/install/use; update both if both are stale (don't make them mirror each other).
- Ask before changing policy, philosophy, positioning, or workflow intent.
- Ignore temporary/generated/local-only/unrelated untracked files; ask before broadening scope to unrelated user changes.
- After repo-reality changes, re-check both docs and mention any freshness updates in your final response.

## Planning and design

Substantial plans or design decisions go through `/grill-with-docs`, which produces a numbered ADR per decision in `docs/adr/` (glossary + decision + why; see `0001`–`0006` for the format).

- ADRs are the home for *decisions + rationale + rejected alternatives*. AGENTS.md holds only the operational rule plus a link to the ADR.
- When a decision changes, add or supersede an ADR rather than rewriting history; update the AGENTS.md pointer to match.

## Commands

```sh
bun run dev        # vite dev on :3000 (or next free port)
bun run build      # production build (also prerenders /)
bun run typecheck  # tsc --noEmit
bun run test:e2e   # playwright (chromium) end-to-end tests
bun run test:e2e:ui  # same, in Playwright's interactive UI
bun run build:cf   # vite build + copy _shell.html -> index.html (Cloudflare)
bun run cf:dev     # build:cf, then `wrangler dev` (local Workers preview)
bun run deploy     # build:cf, then `wrangler deploy`
```

`typecheck` is **red on a pre-existing, unrelated basis** (an unused `src/components/ui/form.tsx` imports uninstalled `radix-ui`/`react-hook-form`; `vite.config.ts` wants `@types/node`). The bundler ignores these and build/deploy succeed — don't treat them as regressions, but a real change must not *add* errors.

**No unit-test runner and no linter** — `typecheck` is the only static gate; run it after any change. End-to-end behavior is **Playwright** (`e2e/`, chromium-only, dev server on port 3210, reuses a running one). Specs seed via `seedOutline` (`e2e/fixtures.ts`), which **`page.route`-intercepts `/api/nodes`** (and `/api/kv`) with an in-memory `Map` mock of the Worker (GET all / POST upsert / PATCH `{updates}` / DELETE `{ids}`/`{keys}`) — so the real `collection.ts`/`api.ts`/`kv-api.ts` path runs against a Map, no `wrangler dev` needed. The store is per-`page`, so `fullyParallel` tests never share state. `e2e/` is outside `tsconfig.json`'s `include`, so it doesn't affect `typecheck`.

**Caret in a contentEditable test:** don't use `Home`/`End`/arrow keys (unreliable in macOS Chromium contentEditable) and don't rely on `.click()` (lands *past* the bullet text — the `.node-text` span is wider than its text). Set the Selection range directly via `evaluate` (see the `caretAt` helper in `e2e/enter-split.spec.ts`). `toHaveText` normalizes whitespace — prefer space-free fixture text (`"alphabravo"`) or `allTextContents()` for exact comparison.

## Generated files

`src/routeTree.gen.ts` is **auto-generated** by the TanStack Start Vite plugin — never hand-edit. After adding/renaming a file in `src/routes/`, run `bun run dev` once to regenerate it, else `typecheck` fails on typed routes.

## SPA mode (no SSR)

Don't run code that touches `nodesCollection` during a server/render pass. Why: [ADR 0004](./docs/adr/0004-spa-only-no-ssr.md).

## Deploying to Cloudflare (Worker + D1 sync)

**One Worker** (`worker/index.ts`) on **Cloudflare Workers** (not Pages) serves the static SPA (via `ASSETS`) and the **D1**-backed sync API: `/api/nodes` (outline) and `/api/kv` (plugin side-collections). Design + rejected alternatives: [ADR 0023](./docs/adr/0023-d1-sync-via-worker.md), [ADR 0024](./docs/adr/0024-side-collections-via-kv-table.md), [ADR 0025](./docs/adr/0025-basic-auth-fallback-gate.md).

- **`_shell.html` → `index.html` copy is load-bearing.** SPA mode emits `dist/client/_shell.html`, but Static Assets serves `index.html` for root + SPA fallback. `build:cf` copies it; don't point wrangler at a dir without that copy.
- **`run_worker_first: true`** routes *every* request through the Worker (so it can gate the document load for Basic Auth). The non-`/api` branch serves assets via `env.ASSETS.fetch`, which still applies `single-page-application` fallback for `/$nodeId` routes.
- **Identity = three-tier `authorize()`** (in order): (1) `Cf-Access-Authenticated-User-Email` → owner = that email (Cloudflare Access, preferred); (2) `localhost` → `local-dev` (dev only); (3) prod without Access → **HTTP Basic Auth** against the `APP_PASSWORD` secret, owner `APP_OWNER` (default `'owner'`), **fail-closed if the secret is unset**. Gating every path (not just `/api`) is what triggers the browser's Basic Auth prompt — a `fetch()` 401 won't. **Never relax a tier to trust a client-supplied owner.**
- **The Worker is typechecked separately** (`bun run typecheck:worker`, `worker/tsconfig.json` with `@cloudflare/workers-types`); it lives in `worker/` so its runtime types don't clash with the app's DOM lib. Don't move it under `src/`.
- **Dev loop:** run `bun run dev` (Vite) *and* `bun run dev:api` (`wrangler dev` on :8787, Worker + local D1); first time `bun run db:migrate:local`. `bun run cf:dev` is a production-like single-server preview.
- **Migrations** in `migrations/`; `bun run db:migrate:local` / `:remote`. Run `:remote` **before** the first `bun run deploy`.
- **[ADR 0004](./docs/adr/0004-spa-only-no-ssr.md) still holds:** the React app stays a pure static SPA; D1 work lives in the Worker's `/api/*` handlers, never the render pass.

## Data layer gotchas

- **Nodes live in D1, not localStorage** ([ADR 0023](./docs/adr/0023-d1-sync-via-worker.md)). `nodesCollection` is a TanStack DB query collection over `/api/nodes` (`collection.ts` + `api.ts` + `query-client.ts`); the interface is unchanged, so store/mutations/components didn't change. **Side-collections (`tag-colors.ts`, `daily-index.ts`) are D1-backed too** ([ADR 0024](./docs/adr/0024-side-collections-via-kv-table.md)) over a generic `/api/kv?collection=<name>` store (`kv-api.ts`); each passes its **concrete** zod schema inline (a generic factory loses schema inference). The old `dotflowy-oss:*` localStorage keys are no longer read.
- **First-run bootstrap = import-or-seed.** On mount `OutlineEditor` calls `bootstrapOutline()` (`seed.ts`): `importLegacyNodes()` first (one-time pre-D1 localStorage → D1 migration into an *empty* D1, guarded by a `dotflowy-oss:d1-imported` flag, non-destructive), then `seedIfEmpty()` only if nothing imported. Keep the **single guard in `bootstrapOutline`** — splitting it races import vs. seed under StrictMode. Covered by `e2e/import-legacy.spec.ts`.
- **e2e seeds through the API, not localStorage** (`seedOutline` mocks `/api/nodes`). Don't reintroduce a localStorage node seed for the live store. (The import spec writes the legacy localStorage shape on purpose.)
- **Build nodes via `makeNode()` in `tree.ts`** — don't add zod `.default()` values to `schema.ts`. Why: [ADR 0005](./docs/adr/0005-no-zod-defaults-in-schema.md).
- **Mutations operate on the live `TreeIndex`.** Every `mutations.ts` function takes the current index and mutates `nodesCollection` directly. The editor passes `focusIndex.current` (a ref) into the `useMemo`-stable `commands` object, which is how its closures read live values. [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).
- **Per-node subscriptions, not a threaded index.** Components read the **tree store** (`tree-store.ts`): `useNode(id)`, `useVisibleChildIds(parentId, showCompleted)`, `useTreeIndex()`. `OutlineNode` takes a `nodeId` and reads its own slice, so a keystroke re-renders only the changed bullet. **Don't pass `node`/`index` as props to `OutlineNode`.** [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).

## Styling

Inline Tailwind classes, not a separate CSS file. Why: [ADR 0006](./docs/adr/0006-inline-tailwind-styling.md).

## Editor internals (OutlineEditor + OutlineNode)

- **`OutlineNode` = a `memo`'d wrapper + `OutlineNodeBody`.** The wrapper calls `useNode(nodeId)` and early-returns when the node is gone; keep all other hooks in the body (rules-of-hooks). The memo only pays off while `commands`/`registerRef`/`pivotId`/`showCompleted` stay referentially stable — never pass a fresh object/callback per render. [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).
- **contentEditable text sync is manual.** The `node-text`/title spans are contentEditable, not controlled React. Stored text is written to the DOM only when it differs (to avoid clobbering the caret); `onInput` pushes to the store. Don't convert to React-controlled text.
- **The `refs` registry maps node id → contentEditable span.** List bullets register under their own id; the zoomed **title registers under `rootId`**. So `refs.current.get(id)` works whether that node is a title or a list item — focus, pending-focus, and the zoom morph all rely on this.
- **Enter splits the bullet at the caret.** Text left of the caret stays; text right moves to a new sibling below, focused at its *start* (the lone exception to the end-of-text `pendingFocus` default — `pendingFocusAtStart`). Caret-at-end is the empty-tail case, so Enter at the end of an expanded parent still dives in. One undo step. `e2e/enter-split.spec.ts`.
- **Keyboard expand/collapse is directional, not a toggle:** `Cmd+↓` opens a closed bullet, `Cmd+↑` closes an open one, everything else is a silent no-op; both always `preventDefault`, one level, focus stays. [ADR 0007](./docs/adr/0007-keyboard-expand-collapse.md).
- **Arrow Up/Down crosses bullets from the edge *visual line*, preserving the caret column** (rect comparison, not text offset; lands via `caretPositionFromPoint`). The neighbor walk (`findVisibleNeighbor` → `flattenVisible`) **must mirror render visibility** (skip completed when `showCompleted` is off) or focus silently no-ops. [ADR 0008](./docs/adr/0008-column-preserving-caret-nav.md).
- **Cmd+Shift+↑/↓ moves a bullet among *visible* siblings; at the edge it outdents one level** (never dives into a sibling subtree, no-op past the zoom root). `moveUp`/`moveDown` in `mutations.ts`. [ADR 0009](./docs/adr/0009-move-node-among-siblings.md).
- **Dragging the bullet dot reorders *and* reparents in one drop** (mouse + touch; y picks the gap, x picks depth). Lives in `use-drag-reorder.ts`, runs imperatively on the hot path. The dot still zooms on a plain click (a movement threshold + `consumeClick()` split drag from click). [ADR 0010](./docs/adr/0010-drag-to-reorder-and-reparent.md).
- **A moved bullet flashes then fades** (`flash-node.ts`, `.outline-row.node-acted`) as an acted-upon signifier — every keyboard/drag move sets `pendingFlash` alongside `pendingFocus`; `/move`'s "Go" flashes across a navigation via `requestFlashAfterNav`/`consumeFlashAfterNav`. `e2e/move-flash.spec.ts`.

## Zoom + view transitions

Clicking a bullet zooms it to a temporary root. Two rules:
- **The dot zooms (click) and drags (press + move); collapse/expand is the hover chevron** in the left gutter. Don't move zoom onto the collapse control.
- **`rootId` is route-owned** (`routes/index.tsx` → `null`, `routes/$nodeId.tsx` → `nodeId`); don't add editor-local zoom state.

How it's URL-driven, the pivot morph, and why screenshots can't verify it: [ADR 0003](./docs/adr/0003-zoom-via-view-transitions.md).

## Bookmarks

A bookmark is a **saved zoom view**, stored as `bookmarkedAt: number | null` on the node (delete the node, the bookmark goes with it). The header **star** (`BookmarkStar`, `bookmarks.tsx`) pins the current zoom root; **browsing** them lives in the Cmd+K switcher's empty state (the standalone popover was removed). **No sidebar** — the unused `ui/sidebar.tsx` is the documented promotion path. A new persistent `Node` field needs a backfill in `collection.ts` (see `migrateAddBookmarkedAt`). Why: [ADR 0011](./docs/adr/0011-bookmarks-via-header-popover.md), [ADR 0013](./docs/adr/0013-bookmarks-browse-folds-into-switcher.md).

## Node quick-switcher (Cmd+K search)

**Cmd+K** (or the header magnifier on touch) opens a Fuse.js fuzzy jump over every node's text, navigating to the picked node's zoom view; it also renders **plugin-contributed virtual actions** (Seam J). The whole feature is `node-switcher.tsx`, mounted **once in `__root.tsx`** and reached via `openNodeSwitcher()`. The listener is **capture-phase** (fires inside a contentEditable); cmdk's own filter is **off** (Fuse drives the list, with a second non-highlighted `aliases` key). Empty query lists bookmarks; a matching query also shows an "Actions" group. **No `Node` field, no migration.** Why: [ADR 0012](./docs/adr/0012-node-quick-switcher.md), [ADR 0022](./docs/adr/0022-search-provider-seam.md).

## Plugins (`src/plugins`)

The editor is a clean core extended by **plugins** — modules compiled into the bundle (an internal registry, *not* runtime-loaded), one per `src/plugins/<name>/`. `code`, `links`, `tags`, `todos`, `daily`, and `route-bible` are themselves plugins (dogfooded), so the core carries no feature-specific branches. Full seam contract + rationale: [ADR 0018](./docs/adr/0018-plugin-architecture.md); React-widget token mode: [ADR 0028](./docs/adr/0028-react-token-widgets.md).

- **`types.ts`** — the typed contract (`definePlugin`, `El`/`WidgetEl`, `TokenSpec`, `InteractionSpec`, `CommandSpec`, `KeymapSpec`, `SlotSpec`, `HeaderSlotSpec`, `ViewTransform`, `MenuSpec`, `InputSpec`, the Seam-J `Search*` types, `PluginContext`).
- **`index.ts`** — the one explicit ordered array `plugins = [code, links, routeBible, tags, todos, daily]`. Add a plugin = add a folder + one line. Array order is the precedence tiebreak and dispatch order.
- **`registry.ts`** — derives everything from that array once at load (token regex + dispatch, interaction dispatch, view-transform composition, menu/command/keymap lists with the load-time reserved-key guard, row/header slots, `isProtected`, the Seam-J providers, the input chain, `pluginStyles`, `registerWidget`). The core consumes these and stays generic.

Seams wired today (each row: the contract, who owns it):

| Seam | What it is | Owners |
| ---- | ---------- | ------ |
| **A** inline token | regex fragment + `render → El \| WidgetEl`, composed into one `gu` regex; core owns escaping. Folding token emits a `data-src` atom (`contenteditable="false"`); React mode mounts a `<dotflowy-widget>` TSX atom. Precedence: links 0 < code 10 < route-bible 15 < tags 20. | code, links, tags, route-bible |
| **B** delegated interaction | one set of content-container handlers, dispatched by `target.closest(selector)`; core has zero feature knowledge. | links, tags, route-bible |
| **C** `/` command | `CommandSpec`; the `/` list is `[...commandSpecs, ...CORE]`. `/move` stays core. | todos (`/todo`,`/bullet`), daily ("Send to Today") |
| **D** keymap | `{hotkey, run}`; reserved-key denylist guarded at load. | todos (`Mod+Enter`/`Mod+D`) |
| **E** side-collection | plugin-owned data, no `Node` field (see Tag colors, below). | tags |
| **F** row slot | `{position:"row:before-text", render(node,getCtx)}`, real JSX. | todos (checkbox) |
| **F** header slot | `{id, render(getCtx)}`, real JSX, no node — [ADR 0020](./docs/adr/0020-header-slot-seam.md). | daily ("Today") |
| **G** view transform | per-node `hidesNode` predicate (composed into the one `isHidden`) + optional global `buildFilter`. Core no longer hardcodes `completed`. | todos (hide-completed), tags (`?q=`) |
| **H** caret menu | `MenuSpec` (`trigger` + `entries`), driven by the generic `useMenus` engine. | tags (`#`) |
| **I** input | `input.onPaste` (replacement string) + `input.autoformat` (rewrite just-typed text). | links (paste), todos (`[]`) |
| **J** search providers | `searchAliases`/`searchActions`/`searchAnnotation`; ctx is the minimal `{index, goTo}`, not a `PluginContext` — [ADR 0022](./docs/adr/0022-search-provider-seam.md). | daily |
| — | **overlay host** `ctx.openOverlay(node\|null)`; **protected nodes** `protects(id)` (delete-only no-op) — [ADR 0021](./docs/adr/0021-protected-nodes.md); **plugin styles seam** (static CSS, currently no consumer) — [ADR 0027](./docs/adr/0027-plugin-styles-seam.md). | tags (picker), daily (container) |

Feature → seams: **code** A · **links** A+B+I · **route-bible** A(widget)+B · **tags** A+B+E+G+H · **todos** C+D+F+G+I · **daily** C+F(header)+F(row)+J+protected.

**Still core-wired (deliberately, awaiting future seams):** fade-inheritance (`faded`/`ancestorCompleted`) and Backspace-on-the-checkbox demotion still read `completed`/`isTask` in `OutlineNode`; the `/` palette still runs `useSlashMenu` (only its command *list* is registry-driven).

**Constraints when touching this:** keep token `render` output byte-stable (the `decorate` cache compares strings) and allocation-light (runs per keystroke); never hand the core raw HTML (return `El`/`WidgetEl`); don't reintroduce N separate token scans.

## Tag filtering + colors (`src/plugins/tags/`)

`#tags` are **parsed from `node.text`**, never stored. Each renders as a clickable chip (Seam A token); a plain click AND-s that tag into a **URL-driven filter** (`?q=#a #b`) scoped to the zoom `rootId`, re-rendering a **pruned tree** (matches + dimmed ancestor context, everything else hidden). **Filtering is render-time only — it never mutates `collapsed`.** The filter is a Seam-G transform (`buildTagFilter`); the click is Seam-B delegated (`onClick → ctx.nav.filterTag`). Pure logic in `src/data/tags.ts`. `#` autocomplete is the tags plugin's Seam-H menu. v1 is click-driven, tags-only (no free text, no `@`-mentions). Why: [ADR 0015](./docs/adr/0015-tag-filtering.md).

**Colors** are *chosen* per tag name (not derived) and stored in the `tagColorsCollection` side-collection (Seam E) — so they sync and apply to every instance. Painted by **one generated stylesheet** keyed on `data-tag` (`TagColorStyles`, mounted once in `__root.tsx`), so recoloring is an O(1) DOM write with **zero React re-renders**. The picker (`TagColorMenu`) opens on **right-click** (Seam-B `onContextMenu` → `ctx.openOverlay`); the generator skips unsafe tag names (no CSS injection). Why: [ADR 0016](./docs/adr/0016-custom-tag-colors.md).

## Rich links (`src/plugins/links/`)

Markdown `[label](url)` **parsed from `node.text`** (Seam A+B+I token), the only construct that **folds**: reveal is **per-link** (Obsidian Live Preview style) — a link shows raw only when the caret is within/adjacent (source offset ∈ `[start, end]`); every other link folds to a clean `<a contenteditable="false">`. At most one reveals at a time.

The landmine: a focused bullet can hold **folded** links, so `el.textContent` is no longer the source. The core is **source-offset-aware** — **`readSource(el)`** (inline-code.ts) reconstructs the markdown (`data-src` for folded `<a>`, `textContent` otherwise) and replaces `el.textContent` in `onInput`/paste **and the slash/tag menus** (else a `/cmd` on a folded-link line drops its url); **`getCaretOffset`/`setCaretOffset`** speak SOURCE offsets, counting a folded link's `data-src-len`. Reveal reflow is a `selectionchange` watcher (`watchCaretReveal`) live only while focused; all of this early-returns on link-free lines (the 99% case). Folded links open on click (Seam-B `window.open`); creation is hand-typed or paste (Seam-I `input.onPaste`, http(s) only, URLs percent-encoded). Search indexes `stripLinks(node.text)`. Why: [ADR 0017](./docs/adr/0017-rich-links.md).

## Daily notes (`src/plugins/daily/`)

A daily note is a normal node addressed by a date; the header **Today button** navigates to today's, creating it on first use. **No `Node` field, no migration, no route.** Why: [ADR 0019](./docs/adr/0019-daily-notes-plugin.md).

- **Identity is a side-collection.** `dailyIndexCollection` (`daily-index.ts`) maps a key → `nodeId`: a **local** date `YYYY-MM-DD` (use `localDateKey()`, **not** `toISOString` — day boundary is local midnight) or the `container` sentinel. Never derive a day from `node.text`.
- **Structure.** Days are children of one auto-created **"Daily" container** (a **protected node**, since `removeNode` cascades). New days insert at the top (newest-first). `goToDate(key, ctx)` is get-or-create, idempotent and self-healing; creation uses low-level `mutations.ts` primitives directly (not `ctx.mutations` — wrong capture/focus semantics for a navigate-away create).
- **Display.** Text is seeded to the full date ("Tuesday, June 23, 2026"); a `<Badge>` row slot shows a relative label (Today/Yesterday/Jun 23), driven by the mapping (always correct).
- **Seam C** "Send to Today" (labeled to avoid shadowing `/move`); **Seam J** aliases each day with its relative label, adds a "Go to Today" virtual action (create-when-absent), and a `(Today)` picker annotation. Covered by `e2e/daily-notes.spec.ts`.

## Scripture references (`src/plugins/route-bible/`)

A Bible ref in `node.text` renders as a chip opening [route.bible](https://route.bible) (Seam A widget + Seam B click — the links shape minus the fold). **No `Node` field, no migration.** Why: [ADR 0026](./docs/adr/0026-route-bible-plugin.md), [ADR 0028](./docs/adr/0028-react-token-widgets.md).

- **Liberal regex PROPOSES, `grab-bcv` DISPOSES.** `BIBLE_REF_PATTERN` (`bible.ts`) requires a chapter, verse optional, and over-matches on purpose; `resolveBibleRef(tok)` runs the candidate through grab-bcv's `tryParsePassage` and returns null for non-references (the core then renders raw text). Dependency is **`grab-bcv`** (parse + `toResolverUrl`), not `@route-bible/core`.
- **A real-TSX atomic widget** ([ADR 0028](./docs/adr/0028-react-token-widgets.md)): `render` returns a `WidgetEl` + `component: BibleChip`; the core serializes it to a `<dotflowy-widget>` atom and mounts `BibleChip` (`chip.tsx`) — lucide icons + Tailwind, **no plugin CSS**. `readSource` reads `data-src`; the caret jumps over it.
- v1 is liberal by explicit call (accepts `Matthew 5 minutes` → `Matthew 5`); tightening is a one-line regex change. Covered by `e2e/route-bible.spec.ts`.

## Environment gotcha: adding a React-importing dependency

`bun add`-ing a package that imports React (e.g. `lucide-react`) while `bun run dev` is running may crash with "Invalid hook call / multiple copies of React" — a stale Vite dep-optimize cache, not a code bug. Fix: stop the server, `rm -rf node_modules/.vite`, restart.

## Verifying UI changes

Screenshots **cannot capture view-transition overlays** (they show the settled DOM, so a morph always looks "done"). Verify transitions by instrumenting `document.startViewTransition` and asserting on which element holds `view-transition-name`.
