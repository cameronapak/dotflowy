<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# Project Guidance

> [!IMPORTANT]
> **Wasp migration complete (Phase 4).** The app runs on **Wasp + PostgreSQL**
> (Railway in prod). Start with **`wasp start`** (Node 24 + Postgres —
> `wasp start db` or `DATABASE_URL`), not legacy Cloudflare/wrangler commands.
> D1 export/import: `scripts/export-d1.sh` / `scripts/import-d1-export.ts`
> (`cloudflare-legacy/` keeps the old D1 schema + export-only wrangler config).

Guidance for coding agents working in this repo. `CLAUDE.md` is a symlink to this file.

`README.md` covers the data model, persistence, backend-swap path, and project layout — read it first and don't duplicate it here. This file is the non-obvious operational stuff: commands, gotchas, and the one rule per feature. The few decisions whose *why* isn't visible in the code live in [`docs/DECISIONS.md`](./docs/DECISIONS.md) — read that when a rule below points at it.

## Error Handling

This codebase uses the errore.org convention. ALWAYS read the errore skill before editing any code.

## Documentation Freshness

Repo reality is the source of truth. If `AGENTS.md` or `README.md` becomes false about an objective fact (repo structure, paths, commands, tooling, workflow constraints proven by the repo), fix it in the same change.

- Update `AGENTS.md` for stale agent-facing facts, `README.md` for stale human-facing purpose/install/use; update both if both are stale (don't make them mirror each other).
- Ask before changing policy, philosophy, positioning, or workflow intent.
- Ignore temporary/generated/local-only/unrelated untracked files; ask before broadening scope to unrelated user changes.
- After repo-reality changes, re-check both docs and mention any freshness updates in your final response.

## Planning and design

Substantial plans or design decisions go through `/grill-with-docs` — a relentless interview that *sharpens* the decision. It does **not** mint a doc per decision.

- A decision earns a written record **only if an agent reading the code alone would get it wrong** — the *why* is non-obvious and the obvious "fix" breaks something. Those few live in [`docs/DECISIONS.md`](./docs/DECISIONS.md) (one file, scannable in one pass).
- If the code already makes the call obvious, the code is the doc — don't write it down.
- When a decision changes, edit its entry in place (or delete it). History — including superseded decisions and their rejected alternatives — is in `git log`, not a pile of superseding files.

## Commands

```sh
wasp start         # Wasp dev (client :3000, server :3001) — needs Node 24 + Postgres
wasp start db      # managed local Postgres (Docker) for first-time dev
wasp compile       # regenerate .wasp/out + Prisma client after spec/schema changes
bun run typecheck  # tsc -b tsconfig.src.json (editor + Wasp server ops under src/)
bun run test:e2e   # playwright (chromium) against wasp start (:3000)
bun run test:e2e:ui
bash scripts/export-d1.sh backups/d1-export.json   # one-time pre-cutover D1 backup
bun scripts/import-d1-export.ts --file backups/d1-export.json --user-email you@example.com
npx -y react-doctor@latest . --verbose  # React health scan; tuned via doctor.config.json
```

**No unit-test runner and no linter** — `typecheck` is the only static gate; run it after any change (after `wasp compile` if you touched `schema.prisma` or `*.wasp.ts`). End-to-end behavior is **Playwright** (`e2e/`, chromium-only, **`wasp start` on :3000**, reuses a running one). `e2e/auth.setup.ts` logs in once; specs call `seedOutline` (`e2e/fixtures.ts`), which **`page.route`-intercepts Wasp operations** (`/operations/get-nodes`, `/operations/upsert-nodes`, … and plugin ops) with in-memory Maps — so the real `collection.ts`/`api.ts` path runs against mocks, no Postgres seed needed per test. The store is per-`page`, so `fullyParallel` tests never share state. `e2e/` is outside `tsconfig.src.json`'s `include`, so it doesn't affect `typecheck`.

**Caret in a contentEditable test:** don't use `Home`/`End`/arrow keys (unreliable in macOS Chromium contentEditable) and don't rely on `.click()` (lands *past* the bullet text — the `.node-text` span is wider than its text). Set the Selection range directly via `evaluate` (see the `caretAt` helper in `e2e/enter-split.spec.ts`). `toHaveText` normalizes whitespace — prefer space-free fixture text (`"alphabravo"`) or `allTextContents()` for exact comparison.

## Generated files

Wasp generates `.wasp/out/` (including the SDK and Prisma client). Never hand-edit generated output. Run `wasp compile` after changing `main.wasp.ts`, `*.wasp.ts`, or `schema.prisma`.

## SPA mode (no SSR)

Don't run code that touches `nodesCollection` during a server/render pass. Why: [the SPA/no-SSR constraint in `docs/DECISIONS.md`](./docs/DECISIONS.md#d1-sync-via-a-worker) (historical ADR; constraint still applies on Wasp).

## Deploying to Railway (Wasp + Postgres)

**Wasp** serves the React SPA and Wasp **queries/actions** on Node/Express, backed by **PostgreSQL** (Railway in prod). Auth is email/password; every operation scopes to `context.user.id`. Design: [`docs/PRD-wasp-migration.md`](./docs/PRD-wasp-migration.md).

- **One-time:** `wasp deploy railway launch` (provisions app + Postgres, sets env vars).
- **Ship:** `wasp deploy railway deploy`.
- **Migrations:** Prisma migrations in `migrations/` apply on server start — commit them before deploy.
- **Email:** `main.wasp.ts` uses the Dummy sender in dev; switch to a real provider before production signup.
- **Founder cutover:** export D1 with `bash scripts/export-d1.sh`, import with `bun scripts/import-d1-export.ts` (see `cloudflare-legacy/README.md`).
- **The SPA/no-SSR rule still holds:** never touch `nodesCollection` during a server/render pass.

Historical Cloudflare Worker + D1 deploy notes: [D1 sync via a Worker](./docs/DECISIONS.md#d1-sync-via-a-worker) (superseded at Phase 4).

## Data layer gotchas

- **Nodes live in Postgres, not localStorage.** `nodesCollection` is a TanStack DB query collection over Wasp `getNodes` (`collection.ts` + `api.ts` + `query-client.ts`); mutations call `upsertNodes` / `updateNodes` / `deleteNodes`. **Side-collections** (`tag-colors.ts`, `daily-index.ts`) use typed Prisma tables via plugin Wasp operations — not the old generic `/api/kv` store. The old `dotflowy-oss:*` localStorage keys are no longer read for the live store.
- **First-run bootstrap = import-or-seed (per userId).** On mount `OutlineEditor` calls `bootstrapOutline(userId)` (`seed.ts`): `importLegacyNodes()` first (one-time pre-D1 localStorage → server migration into an *empty* silo, guarded by `dotflowy-oss:d1-imported`), then `seedIfEmpty()` only if nothing imported. Guards reset on auth change. Keep the **single guard in `bootstrapOutline`** — splitting it races import vs. seed under StrictMode. Covered by `e2e/import-legacy.spec.ts`.
- **e2e seeds through mocked Wasp operations**, not localStorage (`seedOutline` in `e2e/fixtures.ts`). Don't reintroduce a localStorage node seed for the live store.
- **Build nodes via `makeNode()` in `tree.ts`** — don't add zod `.default()` values to `schema.ts`. Why: [No zod defaults](./docs/DECISIONS.md#no-zod-defaults-in-the-schema).
- **Mutations operate on the live `TreeIndex`.** Every `mutations.ts` function takes the current index and mutates `nodesCollection` directly. The editor passes `focusIndex.current` (a ref) into the `useMemo`-stable `commands` object, which is how its closures read live values. [Tree store](./docs/DECISIONS.md#localized-rendering-via-the-tree-store).
- **Per-node subscriptions, not a threaded index.** Components read the **tree store** (`tree-store.ts`): `useNode(id)`, `useVisibleChildIds(parentId, showCompleted)`, `useTreeIndex()`. `OutlineNode` takes a `nodeId` and reads its own slice, so a keystroke re-renders only the changed bullet. **Don't pass `node`/`index` as props to `OutlineNode`.** [Tree store](./docs/DECISIONS.md#localized-rendering-via-the-tree-store).

## Styling

Inline Tailwind classes, not a separate CSS file (separate CSS only for the view-transition rules in `styles.css`).

## Editor internals (OutlineEditor + OutlineNode)

- **`OutlineNode` = a `memo`'d wrapper + `OutlineNodeBody`.** The wrapper calls `useNode(nodeId)` and early-returns when the node is gone; keep all other hooks in the body (rules-of-hooks). The memo only pays off while `commands`/`registerRef`/`pivotId`/`showCompleted` stay referentially stable — never pass a fresh object/callback per render. [Tree store](./docs/DECISIONS.md#localized-rendering-via-the-tree-store).
- **contentEditable text sync is manual.** The `node-text`/title spans are contentEditable, not controlled React. Stored text is written to the DOM only when it differs (to avoid clobbering the caret); `onInput` pushes to the store. Don't convert to React-controlled text.
- **The `refs` registry maps node id → contentEditable span.** List bullets register under their own id; the zoomed **title registers under `rootId`**. So `refs.current.get(id)` works whether that node is a title or a list item — focus, pending-focus, and the zoom morph all rely on this.
- **Enter splits the bullet at the caret.** Text left of the caret stays; text right moves to a new sibling below, focused at its *start* (the lone exception to the end-of-text `pendingFocus` default — `pendingFocusAtStart`). Caret-at-end is the empty-tail case, so Enter at the end of an expanded parent still dives in. One undo step. `e2e/enter-split.spec.ts`.
- **Keyboard expand/collapse is directional, not a toggle:** `Cmd+↓` opens a closed bullet, `Cmd+↑` closes an open one, everything else is a silent no-op; both always `preventDefault`, one level, focus stays.
- **Arrow Up/Down crosses bullets from the edge *visual line*, preserving the caret column** (rect comparison, not text offset; lands via `caretPositionFromPoint`). The neighbor walk (`findVisibleNeighbor` → `flattenVisible`) **must mirror render visibility** (skip completed when `showCompleted` is off) or focus silently no-ops.
- **Cmd+Shift+↑/↓ moves a bullet among *visible* siblings; at the edge it reparents into the parent's adjacent sibling as a child** (no-op when there is no aunt/uncle, or when the node sits directly under the zoom root). `moveUp`/`moveDown` in `mutations.ts`.
- **Dragging the bullet dot reorders *and* reparents in one drop** (mouse + touch; y picks the gap, x picks depth). Lives in `use-drag-reorder.ts`, runs imperatively on the hot path. The dot still zooms on a plain click (a movement threshold + `consumeClick()` split drag from click).
- **A moved bullet flashes then fades** (`flash-node.ts`, `.outline-row.node-acted`) as an acted-upon signifier — every keyboard/drag move sets `pendingFlash` alongside `pendingFocus`; `/move`'s "Go" flashes across a navigation via `requestFlashAfterNav`/`consumeFlashAfterNav`. `e2e/move-flash.spec.ts`.

## Zoom + view transitions

Clicking a bullet zooms it to a temporary root. Two rules:
- **The dot zooms (click) and drags (press + move); collapse/expand is the hover chevron** in the left gutter. Don't move zoom onto the collapse control.
- **`rootId` is route-owned** (`OutlinePage`: `/` → `null`, `/:nodeId` → `nodeId`); don't add editor-local zoom state.

It's URL-driven via the route; the pivot morphs with a `view-transition-name`. Screenshots can't verify view transitions — see *Verifying UI changes* below.

## Bookmarks

A bookmark is a **saved zoom view**, stored as `bookmarkedAt: number | null` on the node (delete the node, the bookmark goes with it). The header **star** (`BookmarkStar`, `bookmarks.tsx`) pins the current zoom root; **browsing** them lives in the Cmd+K switcher's empty state (the standalone popover was removed). **No sidebar** — the unused `ui/sidebar.tsx` is the documented promotion path. A new persistent `Node` field needs a backfill in `collection.ts` (see `migrateAddBookmarkedAt`).

## Node quick-switcher (Cmd+K search)

**Cmd+K** (or the header magnifier on touch) opens a Fuse.js fuzzy jump over every node's text, navigating to the picked node's zoom view; it also renders **plugin-contributed virtual actions** (Seam J). The whole feature is `node-switcher.tsx`, mounted **once in `App.tsx`** and reached via `openNodeSwitcher()`. The listener is **capture-phase** (fires inside a contentEditable); cmdk's own filter is **off** (Fuse drives the list, with a second non-highlighted `aliases` key). Empty query lists bookmarks; a matching query also shows an "Actions" group. **No `Node` field, no migration.**

## Plugins (`src/plugins`)

The editor is a clean core extended by **plugins** — modules compiled into the bundle (an internal registry, *not* runtime-loaded), one per `src/plugins/<name>/`. `code`, `links`, `tags`, `todos`, `daily`, and `route-bible` are themselves plugins (dogfooded), so the core carries no feature-specific branches. Design rationale: [Plugin architecture](./docs/DECISIONS.md#plugin-architecture); React-widget token mode: [React token widgets](./docs/DECISIONS.md#react-token-widgets).

- **`types.ts`** — the typed contract (`definePlugin`, `El`/`WidgetEl`, `TokenSpec`, `InteractionSpec`, `CommandSpec`, `KeymapSpec`, `SlotSpec`, `HeaderSlotSpec`, `SubheaderSlotSpec`, `ViewTransform`, `MenuSpec`, `InputSpec`, the Seam-J `Search*` types, `PluginContext`).
- **`index.ts`** — the one explicit ordered array `plugins = [code, links, routeBible, tags, todos, daily]`. Add a plugin = add a folder + one line. Array order is the precedence tiebreak and dispatch order.
- **`registry.ts`** — derives everything from that array once at load (token regex + dispatch, interaction dispatch, view-transform composition, menu/command/keymap lists with the load-time reserved-key guard, row/header/subheader slots, `isProtected`, the Seam-J providers, the input chain, `pluginStyles`, `registerWidget`). The core consumes these and stays generic.

Seams wired today (each row: the contract, who owns it):

| Seam | What it is | Owners |
| ---- | ---------- | ------ |
| **A** inline token | regex fragment + `render → El \| WidgetEl`, composed into one `gu` regex; core owns escaping. Folding token emits a `data-src` atom (`contenteditable="false"`); React mode mounts a `<dotflowy-widget>` TSX atom. Precedence: links 0 < code 10 < route-bible 15 < tags 20. | code, links, tags, route-bible |
| **B** delegated interaction | one set of content-container handlers, dispatched by `target.closest(selector)`; core has zero feature knowledge. | links, tags, route-bible |
| **C** `/` command | `CommandSpec`; the `/` list is `[...commandSpecs, ...CORE]`. `/move` stays core. | todos (`/todo`,`/bullet`), daily ("Send to Today") |
| **D** keymap | `{hotkey, run}`; reserved-key denylist guarded at load. | todos (`Mod+Enter`/`Mod+D`) |
| **E** side-collection | plugin-owned data, no `Node` field (see Tag colors, below). | tags |
| **F** row slot | `{position:"row:before-text", render(node,getCtx)}`, real JSX. | todos (checkbox) |
| **F** header slot | `{id, render(getCtx)}`, real JSX, no node — persistent actions in the header's right cluster. | daily ("Today") |
| **F** subheader slot | `{id, render(getCtx)}`, real JSX, no node — contextual chrome below the header (collapses + animates when every slot returns null; sticks with the header). | tags (filter bar) |
| **G** view transform | per-node `hidesNode` predicate (composed into the one `isHidden`) + optional global `buildFilter`. Core no longer hardcodes `completed`. | todos (hide-completed), tags (`?q=`) |
| **H** caret menu | `MenuSpec` (`trigger` + `entries`), driven by the generic `useMenus` engine. | tags (`#`) |
| **I** input | `input.onPaste` (replacement string) + `input.autoformat` (rewrite just-typed text). | links (paste), todos (`[]`) |
| **J** search providers | `searchAliases`/`searchActions`/`searchAnnotation`; ctx is the minimal `{index, goTo}`, not a `PluginContext`. | daily |
| — | **overlay host** `ctx.openOverlay(node\|null)`; **protected nodes** `protects(id)` (delete-only no-op). | tags (picker), daily (container) |

Feature → seams: **code** A · **links** A+B+I · **route-bible** A(widget)+B · **tags** A+B+E+F(subheader)+G+H · **todos** C+D+F+G+I · **daily** C+F(header)+F(row)+J+protected.

**Still core-wired (deliberately, awaiting future seams):** fade-inheritance (`faded`/`ancestorCompleted`) and Backspace-on-the-checkbox demotion still read `completed`/`isTask` in `OutlineNode`; the `/` palette still runs `useSlashMenu` (only its command *list* is registry-driven).

**Constraints when touching this:** keep token `render` output byte-stable (the `decorate` cache compares strings) and allocation-light (runs per keystroke); never hand the core raw HTML (return `El`/`WidgetEl`); don't reintroduce N separate token scans.

## Tag filtering + colors (`src/plugins/tags/`)

`#tags` are **parsed from `node.text`**, never stored. Each renders as a clickable chip (Seam A token); a plain click AND-s that tag into a **URL-driven filter** (`?q=#a #b`) scoped to the zoom `rootId`, re-rendering a **pruned tree** (matches + dimmed ancestor context, everything else hidden). **Filtering is render-time only — it never mutates `collapsed`.** The tags plugin owns the full filter stack: URL sync, escape-to-clear, the subheader pill bar (Seam F-subheader), the Seam-G transform (`buildTagFilter`), and chip click routing (Seam B). Pure logic in `src/data/tags.ts`. `#` autocomplete is the tags plugin's Seam-H menu. v1 is click-driven, tags-only (no free text, no `@`-mentions).

**Colors** are *chosen* per tag name (not derived) and stored in the `tagColorsCollection` side-collection (Seam E, Postgres via Wasp `getTagColors`/`upsertTagColors`) — so they sync and apply to every instance. Painted by **one generated stylesheet** keyed on `data-tag` (`TagColorStyles`, mounted once in `App.tsx`), so recoloring is an O(1) DOM write with **zero React re-renders**. The picker (`TagColorMenu`) opens on **right-click** (Seam-B `onContextMenu` → `ctx.openOverlay`); the generator skips unsafe tag names (no CSS injection). Why: [Custom tag colors](./docs/DECISIONS.md#custom-tag-colors).

## Rich links (`src/plugins/links/`)

Markdown `[label](url)` **parsed from `node.text`** (Seam A+B+I token), the only construct that **folds**: reveal is **per-link** (Obsidian Live Preview style) — a link shows raw only when the caret is within/adjacent (source offset ∈ `[start, end]`); every other link folds to a clean `<a contenteditable="false">`. At most one reveals at a time.

The landmine: a focused bullet can hold **folded** links, so `el.textContent` is no longer the source. The core is **source-offset-aware** — **`readSource(el)`** (inline-code.ts) reconstructs the markdown (`data-src` for folded `<a>`, `textContent` otherwise) and replaces `el.textContent` in `onInput`/paste **and the slash/tag menus** (else a `/cmd` on a folded-link line drops its url); **`getCaretOffset`/`setCaretOffset`** speak SOURCE offsets, counting a folded link's `data-src-len`. Reveal reflow is a `selectionchange` watcher (`watchCaretReveal`) live only while focused; all of this early-returns on link-free lines (the 99% case). Folded links open on click (Seam-B `window.open`); creation is hand-typed or paste (Seam-I `input.onPaste`, http(s) only, URLs percent-encoded). Search indexes `stripLinks(node.text)`. Why: [Rich links: the source-offset caret](./docs/DECISIONS.md#rich-links-the-source-offset-caret).

## Daily notes (`src/plugins/daily/`)

A daily note is a normal node addressed by a date; the header **Today button** navigates to today's, creating it on first use. **No `Node` field, no migration, no route.**

- **Identity is a side-collection.** `dailyIndexCollection` (`daily-index.ts`) maps a key → `nodeId`: a **local** date `YYYY-MM-DD` (use `localDateKey()`, **not** `toISOString` — day boundary is local midnight) or the `container` sentinel. Never derive a day from `node.text`.
- **Structure.** Days are children of one auto-created **"Daily" container** (a **protected node**, since `removeNode` cascades). New days insert at the top (newest-first). `goToDate(key, ctx)` is get-or-create, idempotent and self-healing; creation uses low-level `mutations.ts` primitives directly (not `ctx.mutations` — wrong capture/focus semantics for a navigate-away create).
- **Display.** Text is seeded to the full date ("Tuesday, June 23, 2026"); a `<Badge>` row slot shows a relative label (Today/Yesterday/Jun 23), driven by the mapping (always correct).
- **Seam C** "Send to Today" (labeled to avoid shadowing `/move`); **Seam J** aliases each day with its relative label, adds a "Go to Today" virtual action (create-when-absent), and a `(Today)` picker annotation. Covered by `e2e/daily-notes.spec.ts`.

## Scripture references (`src/plugins/route-bible/`)

A Bible ref in `node.text` renders as a chip opening [route.bible](https://route.bible) (Seam A widget + Seam B click — the links shape minus the fold). **No `Node` field, no migration.** Widget mode: [React token widgets](./docs/DECISIONS.md#react-token-widgets).

- **Liberal regex PROPOSES, `grab-bcv` DISPOSES.** `BIBLE_REF_PATTERN` (`bible.ts`) requires a chapter, verse optional, and over-matches on purpose; `resolveBibleRef(tok)` runs the candidate through grab-bcv's `tryParsePassage` and returns null for non-references (the core then renders raw text). Dependency is **`grab-bcv`** (parse + `toResolverUrl`), not `@route-bible/core`.
- **A real-TSX atomic widget** ([React token widgets](./docs/DECISIONS.md#react-token-widgets)): `render` returns a `WidgetEl` + `component: BibleChip`; the core serializes it to a `<dotflowy-widget>` atom and mounts `BibleChip` (`chip.tsx`) — lucide icons + Tailwind, **no plugin CSS**. `readSource` reads `data-src`; the caret jumps over it.
- v1 is liberal by explicit call (accepts `Matthew 5 minutes` → `Matthew 5`); tightening is a one-line regex change. Covered by `e2e/route-bible.spec.ts`.

## Environment gotcha: adding a React-importing dependency

`bun add`-ing a package that imports React (e.g. `lucide-react`) while **`wasp start`** is running may crash with "Invalid hook call / multiple copies of React" — a stale Vite dep-optimize cache, not a code bug. Fix: stop the server, `rm -rf node_modules/.vite`, restart.

## Verifying UI changes

Screenshots **cannot capture view-transition overlays** (they show the settled DOM, so a morph always looks "done"). Verify transitions by instrumenting `document.startViewTransition` and asserting on which element holds `view-transition-name`.

# Wasp Knowledge

Wasp knowledge can be found at @.claude/wasp/general-wasp-knowledge.md
