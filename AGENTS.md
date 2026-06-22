<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# Project Guidance

This file provides guidance to coding agents (Claude Code, and any tool reading `AGENTS.md`) when working with code in this repository. `CLAUDE.md` is a symlink to this file.

The `README.md` covers the data model, persistence, sync path, and project layout well — read it first and don't duplicate it here. This file is the stuff that isn't obvious from reading any single file.

## Documentation Freshness

Repo reality is the source of truth. If `AGENTS.md` or `README.md` becomes false, update it in the same change when the fix is objective.

Objective facts include repo structure, tracked paths, setup commands, validation commands, runtime/tooling, skill/resource/prompt inventory, and workflow constraints proven by the repo.

- Update `AGENTS.md` when it is stale about agent-facing repo reality.
- Update `README.md` when it is stale about human-facing purpose, entry points, install, or use.
- Ask before changing policy, philosophy, positioning, or workflow intent.
- If both docs are stale, update both. Do not make them mirror each other unless the same fact belongs in both.
- Ignore temporary, generated, local-only, and unrelated untracked files.
- If unrelated user changes make docs look stale, ask before broadening scope.
- After repo-reality changes, check `AGENTS.md` and `README.md` before finishing.
- In the final response, mention any freshness updates.

## Planning and design

Substantial plans or design decisions go through `/grill-with-docs` — a relentless
interview that sharpens the design and produces docs as it goes. Its output lands in
`docs/adr/`: a numbered ADR per decision, with a glossary and an explicit "why" (see
`docs/adr/0001`–`0006` for the format).

- Keep ADRs as the home for *decisions + rationale + rejected alternatives*. AGENTS.md
  holds only the operational rule plus a link to the ADR.
- When a decision changes, add a new ADR (or supersede an existing one) rather than
  rewriting history; update the AGENTS.md pointer to match.

## Commands

```sh
bun run dev        # vite dev on :3000 (or next free port)
bun run build      # production build (also prerenders /)
bun run typecheck  # tsc --noEmit
```

There is **no test runner and no linter** configured. `typecheck` is the only static gate — run it after any change. The README lists the npm scripts.

## Generated files

- `src/routeTree.gen.ts` is **auto-generated** by the TanStack Start Vite plugin. Never hand-edit it. After adding/renaming a file in `src/routes/`, it regenerates when the dev server (or build) runs — start `bun run dev` once to refresh it, otherwise `typecheck` fails on `to: '/$nodeId'`-style typed routes before the file is updated.

## SPA mode

No SSR — don't run code that touches the Jazz db during a server/render pass. The client (WASM + OPFS + a Worker) is browser-only; `whenDbReady()` deliberately never resolves on the server, and `tree-store` skips its subscription there. Why: [ADR 0004](./docs/adr/0004-spa-only-no-ssr.md).

## Data layer gotchas

- **The backend is Jazz, created once in `src/data/jazz.ts`.** `createDb` is async (loads WASM + OPFS Worker), so the db is a lazy module singleton: `whenDbReady()` returns the load promise, `getDb()` returns the live db (throws if called before ready — which never happens in practice, since user edits only fire after the editor has rendered real nodes). Writes are synchronous and local-first (`getDb().insert/update/delete(app.nodes, ...)`); deletes are **soft** (tombstone) with `restoreNode` to revive them. Why Jazz over the old TanStack DB / Turso plan: [ADR 0016](./docs/adr/0016-jazz-sync-backend.md).
- **Timestamps are `s.float()`, never `s.int()`.** Jazz's `int` is a 32-bit integer; JS epoch-ms (`Date.now()` ~= 1.78e12) overflows it and the runtime throws `invalid value: integer ..., expected i32` on insert. `float` (f64) holds epoch-ms exactly. Applies to `createdAt` / `updatedAt` / `bookmarkedAt`.
- **Build nodes via `makeNode()` in `tree.ts`.** `schema.ts` is a Jazz table now, not a zod schema — `makeNode()` is still the one place node defaults live (the [ADR 0005](./docs/adr/0005-no-zod-defaults-in-schema.md) "no defaults in the schema" rule survives the swap: don't push column defaults into the Jazz table either).
- **Mutations operate on the live `TreeIndex`.** Every function in `mutations.ts` takes the current index (so it can find siblings/order) and writes through `getDb()`. The editor holds the live-derived index in a ref (`focusIndex`) and passes `focusIndex.current` into command handlers — the `commands` object itself is `useMemo`-stable (it must be, since it's a prop on every memoized `OutlineNode`), so the refs are how its closures still read live values. See [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).
- **Per-node subscriptions, not a threaded index.** Components read the tree through the **tree store** (`src/data/tree-store.ts`): one `db.subscribeAll` feeds a shared `TreeIndex`, exposed as `useNode(id)` and `useVisibleChildIds(parentId, showCompleted)` for narrow slices and `useTreeIndex()` (what `useTree()` wraps) for the whole index. Jazz hands back fresh row objects on every delta, so the store applies the delta's row-change stream to a persistent `byId` map to keep object identity stable for unchanged rows — that identity stability is what makes a keystroke re-render only the changed bullet. Don't reintroduce passing `node`/`index` as props to `OutlineNode`, and don't drop the identity-preserving delta merge. Why: [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).

## Styling

Inline Tailwind classes, not a separate CSS file. Why: [ADR 0006](./docs/adr/0006-inline-tailwind-styling.md).

## Editor internals (OutlineEditor + OutlineNode)

These two files have a few coupled patterns worth knowing before touching them:

- **`OutlineNode` is a memoized wrapper + a body.** The exported `OutlineNode` is `memo`'d, calls `useNode(nodeId)`, and early-returns when the node is gone; everything else lives in `OutlineNodeBody`. Keep all other hooks in the body so the wrapper's single pre-return hook stays rules-of-hooks-safe. Its memo only pays off while `commands`/`registerRef`/`pivotId`/`showCompleted` stay referentially stable — don't pass it a fresh object/callback per render. Why: [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).
- **contentEditable text sync is manual.** The `node-text` / title spans are `contentEditable`, not controlled React values. Stored text is written to the DOM (`el.textContent = node.text`) only when it differs, to avoid clobbering the caret mid-typing; `onInput` pushes changes to the store. Don't convert these to React-controlled text.
- **The `refs` registry maps node id → contentEditable span.** It unifies focus and animation: list-item bullets register under their own id, and the zoomed **title registers under `rootId`**. So `refs.current.get(someId)` returns the right element whether that node is currently a title or a list item — focus movement, pending-focus-after-mutation, and the zoom morph all rely on this.
- **Keyboard expand/collapse is directional, not a toggle.** `Cmd+↓` only opens a closed bullet; `Cmd+↑` only closes an open one; every other cell is a silent no-op. Both always `preventDefault` (so the caret never jumps), one level only, focus stays on the parent. Why: [ADR 0007](./docs/adr/0007-keyboard-expand-collapse.md).
- **Arrow Up/Down crosses bullets from the edge *visual line* and preserves the caret column.** The cross test (`atLineStart`/`atLineEnd` in `OutlineNode.tsx`) compares the caret's rect to the element's rect, not text offset — so a single-line bullet crosses at any offset while a wrapped bullet still moves line-by-line internally. Landing uses `caretPositionFromPoint` to hit the same x; don't reach for a text-measurement library (the DOM already has the layout). Why: [ADR 0008](./docs/adr/0008-column-preserving-caret-nav.md).
- **Cmd+Shift+↑/↓ moves a bullet among siblings; at the edge it outdents one level.** Swap with the nearest *visible* sibling (hidden completed ones are skipped, never a dead press); at the first/last visible child it pops out — up-edge to before its parent, down-edge to after it (the existing `outdent`). Never dives into a sibling subtree, never adopts siblings, no-op past the zoom root. `moveUp`/`moveDown` in `mutations.ts`. Why: [ADR 0009](./docs/adr/0009-move-node-among-siblings.md).
- **Dragging the bullet dot reorders *and* reparents in one drop** (mouse + touch). Pointer y picks the gap, pointer x picks depth (clamped to `[depth(below), depth(above)+1]`); it commits through the single `moveNode` mutation. The whole gesture lives in `use-drag-reorder.ts` and runs imperatively (DOM, not React state) on the hot path. The dot still zooms on a plain click — a movement threshold tells drag from click, and `consumeClick()` suppresses the zoom after a real drag. Why: [ADR 0010](./docs/adr/0010-drag-to-reorder-and-reparent.md).

## Zoom + view transitions

Clicking a bullet zooms it to a temporary root (the README's "not built" note is stale). Two rules an agent must not break:

- **The bullet dot zooms (click) and drags (press + move); collapse/expand is the hover chevron** in the left gutter (`OutlineNode`). Don't move zoom onto the collapse control. The dot's click/drag split is owned by `use-drag-reorder.ts` (see ADR 0010).
- **`rootId` is route-owned** (`routes/index.tsx` → `null`, `routes/$nodeId.tsx` → `nodeId`); don't add editor-local zoom state.

How it's URL-driven and how the pivot morph animates: [ADR 0003](./docs/adr/0003-zoom-via-view-transitions.md). That ADR also covers why screenshots can't verify the transition.

## Bookmarks

A bookmark is a **saved zoom view**, stored as `bookmarkedAt: number | null` on the node (not a side table — delete the node and the bookmark goes with it). The header **star** (`BookmarkStar` in `src/components/bookmarks.tsx`) pins the current zoom root; it also owns the trailing divider so it disappears cleanly on home. **Browsing** bookmarks lives in the **node quick-switcher's empty state** (Cmd+K), not the header — the standalone Bookmarks popover was removed once the switcher shipped ([ADR 0013](./docs/adr/0013-bookmarks-browse-folds-into-switcher.md)). **There is deliberately no sidebar** — the unused `ui/sidebar.tsx` is the documented promotion path for when a second nav tenant appears. Adding a new persistent `Node` field means a new column in `schema.ts` plus a default in `makeNode()`; the one-time legacy import in `jazz.ts` (`migrateFromLocalStorage`) also backfills it for docs created before the Jazz swap. Why: [ADR 0011](./docs/adr/0011-bookmarks-via-header-popover.md), [ADR 0013](./docs/adr/0013-bookmarks-browse-folds-into-switcher.md).

## Node quick-switcher (Cmd+K search)

A **Cmd+K** (and the header **magnifier** for touch) opens a fuzzy jump-to over every node's text (Fuse.js), navigating to the picked node's zoom view. It is a *quick-switcher, not a command palette* — v1 runs no actions, only navigation. The whole feature is `src/components/node-switcher.tsx` (self-contained, mirrors `bookmarks.tsx`): `NodeSwitcher` is the `CommandDialog`, mounted **once in `__root.tsx`**; the header `NodeSearchButton` reaches it via the module-level `openNodeSwitcher()`. The Cmd+K listener is **capture-phase** so it fires from inside a contentEditable bullet. cmdk's own filter is **off** (`shouldFilter={false}`) — the list is driven by Fuse. Empty query lists bookmarks; results show breadcrumb context (`buildTrail` in `tree.ts`) and highlight matches. **No new `Node` field, no migration** — recents were deliberately cut. Why: [ADR 0012](./docs/adr/0012-node-quick-switcher.md).

## Environment gotcha: adding a React-importing dependency

If you `bun add` a package that imports React (e.g. `lucide-react`) while `bun run dev` is already running, the app may crash with **"Invalid hook call / multiple copies of React"**. This is a stale Vite dep-optimize cache, not a code bug. Fix: stop the server, `rm -rf node_modules/.vite`, restart. A fresh `bun run dev` and the production build are unaffected.

## Verifying UI changes

The browser preview tool's screenshots **cannot capture view-transition overlays** — they show the settled DOM underneath, so a morph always looks "done" in a screenshot. Verify transitions by instrumenting `document.startViewTransition` and asserting on which element holds `view-transition-name`, not by screenshotting mid-animation.
