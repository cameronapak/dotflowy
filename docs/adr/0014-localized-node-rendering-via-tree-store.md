# ADR 0014: Localized node rendering via a shared tree store

Status: accepted (2026-06-22), implemented.

## Glossary

- **Tree store** (new) — `src/data/tree-store.ts`. One app-wide subscription to `nodesCollection`
  that derives a single `TreeIndex` and exposes narrow, per-component subscriptions:
  `useNode(id)`, `useVisibleChildIds(parentId, showCompleted)`, and `useTreeIndex()` (whole-index).
- **Re-render storm** (fixed) — the prior behavior where one keystroke re-rendered every visible
  `OutlineNode`. Measured: **300 visible bullets → ~300 commits per keystroke** (600 render-fn
  calls counting React's dev double-invoke). O(visible nodes) per keystroke.
- **Pull model** — each `OutlineNode` reads *its own* slice of the tree from the store, instead of
  the whole `index` being threaded down as a prop (the push model).

## Decision

`OutlineNode` no longer receives `node` or `index` as props. It receives a `nodeId` and reads its
own node (`useNode`) and ordered, visibility-filtered child ids (`useVisibleChildIds`) from the
**tree store**. The component is split into a memoized wrapper (`OutlineNode`, one `useNode` call +
early return) and a body (`OutlineNodeBody`, all other hooks). The `commands` object in
`OutlineEditor` is now `useMemo`-stable (live values read through refs: `focusIndex`, `rootIdRef`,
`showCompletedRef`; `navigateZoom` is `useCallback`-stable; `startDrag`/`consumeClick` already
stable). `useTree()` is reimplemented on top of the store so the quick-switcher and bookmarks share
the one subscription.

Result, same 300-node harness: **~300 commits/keystroke → 2** (the edited node, ×dev double-invoke;
~1 in production). Rendering is now O(1) in tree size per keystroke instead of O(n).

## Why

- **`React.memo` was inert.** `useTree` rebuilds a new `index` object on every edit, and it was a
  prop on every `OutlineNode` — a changed reference fails memo's shallow compare, so the whole
  visible tree re-rendered on every keystroke. `commands` (a fresh object literal each render) was a
  second, independent memo-buster. Profiled with React DevTools: typing 5 chars into 300 nodes =
  2,700 re-renders, FPS dropping to 1, frames below 30fps. `tree.ts` already anticipated this
  ("if it ever gets slow, memoize per-parent").
- **Identity is stable for unchanged rows.** An edit is an Immer draft of one row, so `useLiveQuery`
  preserves the object reference of every *other* node (verified empirically: one keystroke changed
  exactly 1 of 300 node references). That makes `useNode`'s snapshot referentially stable for all
  but the edited node, so `useSyncExternalStore` re-renders only that node.
- **A prop-based fix can't be correct.** Sourcing `node` as a prop fails for `completed` /
  `collapsed` / `isTask` toggles: those change a node's own object without changing structure, so the
  parent (whose child-id list is unchanged) wouldn't re-render to thread the new object down. The
  node must be read reactively per component. This is why the store, not just stable props, is
  required.
- **`useVisibleChildIds` returns a stable array.** It only changes identity when the visible child
  set/order changes (insert, delete, reorder, a completion toggle that flips visibility) — never on a
  child's text edit — so a parent doesn't re-render while you type in a child.

### What this does NOT change

- **The data model and mutations.** Mutations still operate on the live `TreeIndex` and mutate
  `nodesCollection` directly; `OutlineEditor` still holds `focusIndex.current` for them. No schema
  change, no migration.
- **contentEditable behavior.** Manual text sync, the `refs` registry, caret nav, drag, and the zoom
  morph are untouched. `pendingFocus`-after-insert still works because `OutlineEditor` still
  re-renders on every change (it reads the whole index) and the store notify mounts the new node
  before the focus effect runs (verified: Enter inserts and focuses the new bullet).
- **SPA/no-SSR.** The store skips its subscription on the server and each hook supplies a
  `getServerSnapshot`; `bun run build` prerenders `/` cleanly. See [ADR 0004](./0004-spa-only-no-ssr.md).

## Rejected alternatives

- **Stabilize `commands` only.** Necessary but insufficient: `index` is still a shared changing prop,
  so memo stays inert and the storm persists.
- **Custom `memo` comparator that ignores `index`.** Breaks for deep trees: a parent can't detect a
  deep descendant changed without recursing, so it would skip and freeze the subtree below it.
- **One live query per node (where `parentId = X`).** TanStack DB can filter but not express the
  `prevSiblingId` linked-list order; deriving order in JS from a child-row query re-emits on any
  child field change. The selector cache gives precise structure-only equality without that.

## Known rough edges

- **`OutlineEditor` still re-renders on every keystroke** (it subscribes to the whole index via
  `useTree`/`useTreeIndex`). That's one component, and its memoized `OutlineNode` children skip, so
  the cost is negligible — left as-is rather than splitting the editor's own subscription.
- **`useVisibleChildIds` recomputes per notify.** Each mounted instance does `childrenOf` + filter +
  `join` on every store change to check equality. O(children) each, O(total) across the tree — same
  order as one index rebuild. Fine at the documented "hundreds to low thousands."
- **No test runner** (AGENTS.md). `typecheck` is the only static gate. Verified by hand via browser
  automation: text-edit localization (600→2), insert+focus, completion toggle + ancestor-fade
  cascade, collapse, arrow nav, zoom routing, delete+focus-restore, undo, slash menu.
