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

`vite.config.ts` enables `spa: { enabled: true }` — there is no SSR. This is deliberate: the TanStack DB collection reads `globalThis.localStorage`, so it must only ever run in the browser. Don't add code that touches `nodesCollection` during a server/render pass.

## Data layer gotchas

- **localStorage shape is not a plain array.** Under key `dotflowy-oss:nodes`, TanStack DB stores an object keyed by id where each value is `{ data: Node, versionKey }` — not `Node[]`. To read it directly: `Object.values(JSON.parse(raw)).map(v => v.data)`.
- **The schema intentionally has no zod `.default()` values** (`src/data/schema.ts`). Defaults make zod's inferred input type optional, which collides with TanStack DB's schema-typed collection overload. Always build complete nodes via `makeNode()` in `tree.ts`; don't add `.default()` to the schema.
- **Mutations operate on the live `TreeIndex`.** Every function in `mutations.ts` takes the current index (so it can find siblings/order) and mutates `nodesCollection` directly. The editor holds the live-derived index in a ref (`focusIndex`) and passes `focusIndex.current` into command handlers, because the `commands` object is recreated each render but closures capture stale values otherwise.

## Styling

Going forward all styles will be inline Tailwind classes instead of a separate CSS file.

## Editor internals (OutlineEditor + OutlineNode)

These two files have a few coupled patterns worth knowing before touching them:

- **contentEditable text sync is manual.** The `node-text` / title spans are `contentEditable`, not controlled React values. Stored text is written to the DOM (`el.textContent = node.text`) only when it differs, to avoid clobbering the caret mid-typing; `onInput` pushes changes to the store. Don't convert these to React-controlled text.
- **The `refs` registry maps node id → contentEditable span.** It unifies focus and animation: list-item bullets register under their own id, and the zoomed **title registers under `rootId`**. So `refs.current.get(someId)` returns the right element whether that node is currently a title or a list item — focus movement, pending-focus-after-mutation, and the zoom morph all rely on this.

## Zoom + view transitions

The README still lists "zoom-to-node" as not built — it is. Clicking a bullet zooms it to a temporary root.

- **URL-driven.** `rootId` comes from the route: `routes/index.tsx` renders `<OutlineEditor rootId={null}>`, `routes/$nodeId.tsx` renders `<OutlineEditor rootId={nodeId}>`. The zoom view is `key={nodeId}` so it remounts per node (prevents stale view-transition names leaking between consecutive zooms).
- **The bullet dot zooms; collapse/expand is the hover chevron** in the left gutter (`OutlineNode`). Don't move zoom back onto the collapse control.
- **Animation = a shared-element morph via the View Transitions API**, driven through TanStack Router's `viewTransition` option (it wraps navigation in `document.startViewTransition`). The unifying idea is the **pivot**: the one node that swaps between title and list-item roles. It claims `view-transition-name: zoom-target` in *both* views, so the browser morphs it.
  - Zoom in → pivot is the clicked node (list item → title). Zoom out (breadcrumb) → pivot is the current root (title → list item).
  - The pivot id rides in **history state** (`HistoryState` is module-augmented with `pivotId` in `OutlineEditor.tsx`). The incoming view names the pivot declaratively (`.vt-morph` class + inline `viewTransitionName`); `navigateZoom` names it imperatively in the outgoing view before navigating.
  - The pivot's flex box is shrunk to fit-content only during the transition via `:root:active-view-transition-type(zoom) .vt-morph { flex-grow: 0 }`, so old and new boxes both wrap their text and the morph is a clean scale + translate (without this it slides from the stretched right edge). Reduced motion is respected (`prefersReducedMotion()` + a CSS `@media` guard).

## Environment gotcha: adding a React-importing dependency

If you `bun add` a package that imports React (e.g. `lucide-react`) while `bun run dev` is already running, the app may crash with **"Invalid hook call / multiple copies of React"**. This is a stale Vite dep-optimize cache, not a code bug. Fix: stop the server, `rm -rf node_modules/.vite`, restart. A fresh `bun run dev` and the production build are unaffected.

## Verifying UI changes

The browser preview tool's screenshots **cannot capture view-transition overlays** — they show the settled DOM underneath, so a morph always looks "done" in a screenshot. Verify transitions by instrumenting `document.startViewTransition` and asserting on which element holds `view-transition-name`, not by screenshotting mid-animation.
