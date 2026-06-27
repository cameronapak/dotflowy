# Localized rendering via the tree store

`OutlineNode` takes a `nodeId` and reads **its own slice** from the tree store (`useNode`,
`useVisibleChildIds` in `tree-store.ts`) — it never receives `node` or `index` as props. A
keystroke then re-renders only the edited bullet (measured: ~300 commits/keystroke → ~1) instead
of the whole visible tree.

**Why it's not in the code:** `React.memo` on `OutlineNode` looks like it should already prevent
this. It was inert — `useTree` rebuilt a fresh `index` object every edit and passed it as a prop,
busting the shallow compare. The fix isn't "memoize harder"; the node must be read *reactively per
component*, because completion/collapse/task toggles change a node's own object without changing
structure, so a parent threading the node down as a prop wouldn't re-render to pass the new one.
Why per-node `memo` works at all: Immer keeps the object reference of every *unchanged* row stable
across an edit, so each `useNode` snapshot is referentially stable for all but the edited node.

**Two read paths for the live tree and view state.** The `commands`/drag/zoom closures must keep a
stable identity (a prop on every memoized node), so they can't close over this render's
`index`/`rootId`/`isHidden`. **Render reads** use the React values directly (the `index` from
`useTree`, the `rootId` prop, the `isHidden` memo) so the view stays reactive. **Event-time reads**
(pointer/key/click — after commit) go through module getters: `getTreeIndex()` (`tree-store.ts`) for
the tree, `getViewRootId()`/`getViewIsHidden()` (`view-state.ts`) for the zoom root + visibility
prune. The mirrors are written in effects (`useSyncViewState`), never during render, so `OutlineEditor`
stays React-Compiler-eligible (a ref written during render bails the compiler on the whole function).

**Don't:**
- Pass `node`/`index` as props to `OutlineNode` (reintroduces the storm).
- Pass a fresh `commands`/callback object per render — the memo only pays off while those stay
  referentially stable.
- "Fix" it with a custom memo comparator that ignores `index` — a parent can't tell a deep
  descendant changed without recursing, so it freezes the subtree below it.
- Read `getTreeIndex()`/`getViewRootId()`/`getViewIsHidden()` *during render*, or re-add a mirror ref
  written during render — render must use the reactive React value; the getters are event-time only.

**The editor keeps its manual memos even though React Compiler is on.** react-doctor flags
`commands`, `pluginCtx`, `viewCtx`, `isHidden`, `filter`, and `navigateZoom` in `OutlineEditor` as
"redundant manual memoization." They are **not** — measured 2026-06-26 on a 300-node flat outline:
deleting all of them fans a single keystroke out from ~2 `OutlineNode` re-renders to ~600 (every
visible bullet). The reason is non-obvious: `commands` and `navigateZoom` get their referential
stability from `useMemo`/`useCallback` **inside the `useNodeCommands` / `useZoomNavigation` helper
hooks**, and the compiler **does not memoize across a custom hook's return boundary** — without the
manual memo the helper returns a fresh object every render, busting `OutlineNode`'s `memo`. (The
unminified build confirms it: `OutlineEditor` itself compiles, but `useNodeCommands` does not, so its
return is uncached.) Keep these memos; they are permanent accepted react-doctor findings. The fix is
**not** "let the compiler do it" — only inlining the helper hooks into the compiled component would
let the compiler reach them, a larger and riskier refactor with no user-facing benefit.
