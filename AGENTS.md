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

The `README.md` covers the data model, persistence, backend-swap path, and project layout well — read it first and don't duplicate it here. This file is the stuff that isn't obvious from reading any single file.

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

No SSR — don't run code that touches `nodesCollection` during a server/render pass. Why: [ADR 0004](./docs/adr/0004-spa-only-no-ssr.md).

## Data layer gotchas

- **localStorage shape is not a plain array.** Under key `dotflowy-oss:nodes`, TanStack DB stores an object keyed by id where each value is `{ data: Node, versionKey }` — not `Node[]`. To read it directly: `Object.values(JSON.parse(raw)).map(v => v.data)`.
- **Build nodes via `makeNode()` in `tree.ts`.** Don't add zod `.default()` values to `src/data/schema.ts`. Why: [ADR 0005](./docs/adr/0005-no-zod-defaults-in-schema.md).
- **Mutations operate on the live `TreeIndex`.** Every function in `mutations.ts` takes the current index (so it can find siblings/order) and mutates `nodesCollection` directly. The editor holds the live-derived index in a ref (`focusIndex`) and passes `focusIndex.current` into command handlers, because the `commands` object is recreated each render but closures capture stale values otherwise.

## Styling

Inline Tailwind classes, not a separate CSS file. Why: [ADR 0006](./docs/adr/0006-inline-tailwind-styling.md).

## Editor internals (OutlineEditor + OutlineNode)

These two files have a few coupled patterns worth knowing before touching them:

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

A bookmark is a **saved zoom view**, stored as `bookmarkedAt: number | null` on the node (not a side table — delete the node and the bookmark goes with it). The header **star** pins the current zoom root; the header **Bookmarks** popover lists them newest-first and each row is a plain `<Link to="/$nodeId">`. The whole feature lives in `src/components/bookmarks.tsx`, self-contained (reads `rootId` from the route, not from the editor). **There is deliberately no sidebar** — the unused `ui/sidebar.tsx` is the documented promotion path for when a second nav tenant appears. Adding a new persistent `Node` field needs a localStorage backfill in `collection.ts` (see `migrateAddBookmarkedAt`). Why: [ADR 0011](./docs/adr/0011-bookmarks-via-header-popover.md).

## Node quick-switcher (Cmd+K search)

A **Cmd+K** (and the header **magnifier** for touch) opens a fuzzy jump-to over every node's text (Fuse.js), navigating to the picked node's zoom view. It is a *quick-switcher, not a command palette* — v1 runs no actions, only navigation. The whole feature is `src/components/node-switcher.tsx` (self-contained, mirrors `bookmarks.tsx`): `NodeSwitcher` is the `CommandDialog`, mounted **once in `__root.tsx`**; the header `NodeSearchButton` reaches it via the module-level `openNodeSwitcher()`. The Cmd+K listener is **capture-phase** so it fires from inside a contentEditable bullet. cmdk's own filter is **off** (`shouldFilter={false}`) — the list is driven by Fuse. Empty query lists bookmarks; results show breadcrumb context (`buildTrail` in `tree.ts`) and highlight matches. **No new `Node` field, no migration** — recents were deliberately cut. Why: [ADR 0012](./docs/adr/0012-node-quick-switcher.md).

## Environment gotcha: adding a React-importing dependency

If you `bun add` a package that imports React (e.g. `lucide-react`) while `bun run dev` is already running, the app may crash with **"Invalid hook call / multiple copies of React"**. This is a stale Vite dep-optimize cache, not a code bug. Fix: stop the server, `rm -rf node_modules/.vite`, restart. A fresh `bun run dev` and the production build are unaffected.

## Verifying UI changes

The browser preview tool's screenshots **cannot capture view-transition overlays** — they show the settled DOM underneath, so a morph always looks "done" in a screenshot. Verify transitions by instrumenting `document.startViewTransition` and asserting on which element holds `view-transition-name`, not by screenshotting mid-animation.
