# 03 — Full editing parity inside mirrors (the hard part)

Status: in progress — 2a, 2b, 2c DONE; 2d–2e remain (branch `feat/mirror-of-plumbing`).
Each slice is its own verified commit, mirroring Stage 1's 1a–1d discipline.

Stage 2 of [PRD](../PRD.md) / [ADR 0022](../../../docs/adr/0022-node-mirrors.md). The A1 gold-plate and the
**most regression-prone work in the app** — path-based identity for the caret-sensitive subsystems inside
mirrored subtrees. Gate on heavy e2e. Behind the flag.

## The keystone insight (read first)

Stage 1 already shipped the address: every `VisibleRow` carries a `key` (`visible-order.ts`). It is the bare
node id until the walk crosses a mirror, then a `PATH_SEP`-joined chain of instance ids. The defining property:

> **`row.key === row.id` for every mirror-free row.**

So Stage 2 is "switch the caret-sensitive subsystems to key off `row.key` instead of bare `id`." Because
key===id off the flag (and on the flag, outside any crossed mirror), the swap is a **no-op for the 99%
outline** — the new behavior engages *only* inside a windowed mirror, where one node id legitimately has two
spans. That invariant is the regression budget: flag-off parity must stay byte-identical, and the e2e proves it.

## Bare-id assumptions to convert (the inventory)

All in `src/components/`. Each is correct today only because no id repeats; each must take/return a `row.key`:

- **`refs: Map<string, span>`** keyed by `instance.id` — `registerRef(instance.id, el)` (`OutlineRow.tsx:371`),
  title registers under `rootId` (`OutlineEditor`). Two rows sharing an id collide; the later registration wins.
- **`pendingFocus` / `pendingFocusAtStart` / `pendingFlash`** (`useOutlineFocus`, `OutlineEditor.tsx:639-641`)
  carry a bare id. Consumed by `FocusPass` via `refs.get(fid)` (`OutlineEditor.tsx:719,736`) and by
  `OutlineRow`'s mount-claim `pendingFocus.current === instance.id` (`OutlineRow.tsx:253,260`).
- **`findFocusedId`** (`OutlineEditor.tsx:653`) reverse-scans `refs` for the active span and returns its id —
  must return the focused **key** (used by undo/redo to restore focus).
- **`findVisibleNeighbor`** (`visible-order.ts:194`) builds `seq = rows.map(r => r.id)` and `indexOf(id)` —
  `indexOf` finds the *first* occurrence, so caret nav inside a mirror lands on the wrong instance.
- **Commands** set `pendingFocus.current = <newId>`. Off the flag the new id IS the key (correct unchanged).
  Inside a mirror the new node appears under every instance; focus must land in the **editing** instance →
  the command composes `activePathPrefix + newInstanceId`. The active prefix comes from `findFocusedId()`.

## Slices

- **2a — identity keystone (focus / refs / flash by `row.key`). DONE.** `refs`/`registerRef`/`pendingFocus`/
  `pendingFlash`/`findFocusedId`/`FocusPass`/the `OutlineRow` mount-claim/`nav.indexOf` (the `rowIndex` map)
  all key off `row.key` now; `OutlineRow` carries a `rowKey` prop. `history.restore` gates focus existence on
  the key's last segment (`instanceIdForKey`) but returns the full key, so undo lands focus back in the same
  instance (design Q1). Pure helpers `parseRowKey` / `instanceIdForKey` / `contentIdForKey` / `rowKeyFor` added
  to `visible-order.ts`, unit-tested. **Plus a keystone fix:** `buildVisibleRows` now anchors the path at the
  crossing mirror (was accumulating *all* root-side ancestors, contradicting its own comment and breaking
  `childKey === rowKeyFor(parentKey, childId)`), so keys inside a mirror are `mirrorId[·childId]*` and compose
  cleanly for 2b/2c — a unit test ties the helper to the address the walk emits. Commands still pass bare ids
  (key===id off-flag / outside a mirror); composing the focus key from the active prefix inside a mirror is
  2c. **Gate met:** 163 unit pass; full e2e green (only the pre-existing daily-notes nav flake, passes
  isolated); every focus-sensitive spec (enter-split, move-flash, mirrors) green; flag-off parity unchanged.
- **2b — caret nav across boundaries. DONE.** `findVisibleNeighbor` takes + returns row keys (`indexOf` on
  keys) and gained a `mirrorsEnabled` param; every caller passes `isMirrorsEnabled()` so the neighbor sequence
  is the rendered sequence (a mirror elsewhere in the view shifts the rows). `onMoveFocus` (Arrow Up/Down) now
  starts the walk from `findFocusedId()` (the focused row's KEY) instead of the bare id the keymap passes —
  load-bearing, because a mirror row's keymap hands over the *content* id, so only the focused span's key
  addresses the right instance. `findFocusedId` is threaded from `useOutlineFocus` through `useNodeCommands`
  (a stable callback, like `refs`). `onDeleteNode` (backspace focus-above) and selection-mode's 4 neighbor
  walks pass the flag too. Mirror-free: keys===ids, unchanged. e2e (mirrors.spec.ts): ArrowDown from a mirror
  enters its OWN windowed child (positioned below it), never the source's row; arrow nav walks between
  windowed instances and back up to the mirror; bottom-of-view holds focus (no teleport). Full e2e green
  (only the pre-existing daily-notes nav flake, passes isolated).
- **2c — structural edits by the field split + path focus. DONE.** The keymap feeds a mirror row the
  CONTENT id (slice 1b: `useBulletKeymap({ node: content })`), so 2c reframed around the ADR 0022 **field
  split** rather than a blanket "redirect to source": each structural command now derives `instanceId` /
  `contentId` from the focused row's **key** (`findFocusedId()` → `instanceIdForKey`; content = `mirrorOf ??
  instance`, flag-gated). **Position ops target the INSTANCE** (`insertSibling`, `indent`, `outdent`,
  `moveUp/Down`, `removeNode` — Tab/move/delete on a mirror's own row move/remove that mirror in its own
  tree, never the source); **content + child inserts target the SOURCE** (Enter-at-end-of-open →
  `insertChildAtStart(contentId)`, text split → `setText(contentId)`), so they window into every instance.
  Inside the windowed subtree the rows are real nodes (instance === content), so those edits were already
  correct — confirmed by e2e. **Enter on a mirror's OWN row never moves source text** (Option A, Cam's
  "best/robust" call): a mid-text split would desync every instance or strand the tail on a local node, so it
  degrades to the empty-tail case (add a node, source text whole). Delete targets the instance so backspacing
  a mirror removes only that mirror (promote-on-source-delete is Stage 3). **Focus** is re-derived from the
  live post-edit render walk (`focusKeyAfterEdit` over `buildVisibleRows`, built from a fresh
  `nodesCollection.toArray` — settled after `runStructural`), never composed by hand, so it can't drift from
  what's on screen and lands in the editing instance under the same mirror anchor; flag-off / mirror-free it
  returns the bare id (zero rebuild). New helpers `parentKeyOf` / `focusKeyAfterEdit` in `visible-order.ts`
  (unit-tested). Each edit stays ONE `runStructural` batch ([ADR 0009](../../../docs/adr/0009-atomic-structural-writes.md)).
  **Plus a pre-existing core bug fix:** `indent` (`mutations.ts`) read the destination parent's last child
  AFTER its `update()`; the tree-store maintains that index IN PLACE and notifies synchronously, so the read
  already included the just-moved node and pointed its own `prevSiblingId` at itself (a self-referencing
  chain). Latent because no e2e single-Tab-indented under the DEV invariant tripwire and a leaf destination
  renders the self-ref identically. Fixed by reading the last child BEFORE the move; gated by an assertion in
  `mirror-editing.spec.ts` that the structural-write tripwire stays silent. **Gate met:** typecheck /
  typecheck:test / lint / 170 unit green; e2e mirrors + keyboard-nav + node-multi-select + the new
  `mirror-editing.spec.ts` green; full e2e green except the pre-existing daily-notes `goHome` nav flake (16/16
  isolated); flag-off parity unchanged.
- **2d — drag-reorder by path.** `use-drag-reorder.ts` + `virtual-nav.ts`: hit-test / projection by `row.key`
  (`virtualRowRect` keyed by key); dropping inside a mirror reorders the **real** source children (and thus
  every instance). Document the surprise.
- **2e — multi-select by path.** `selection-state` `rootIds` + `useSelectionEdge` keyed by `row.key`;
  `runMany` resolves keys to the real nodes. A run inside a mirror operates on the source nodes.

## Open design questions (decide before 2a code)

- **Undo/redo focus under duplicate ids.** `undo()`/`redo()` return a node id to refocus; if that id has two
  rendered keys, which gets focus? Proposed v1: preserve the focused key's **prefix** (restore into the same
  instance the user was in); if the node no longer exists at that path, fall back to the first key matching the
  bare id. Confirm before wiring `findFocusedId` → undo.
- **Focus-key composition source.** The active path prefix is derived from `findFocusedId()` at command time.
  Confirm that's available everywhere a command sets `pendingFocus` (history restore, daily loser-path).
  **Resolved in 2c:** rather than *compose* `activePrefix + newId` by hand (fragile across reparent moves),
  the focus key is *re-derived* from the live post-edit render walk (`focusKeyAfterEdit` over
  `buildVisibleRows`), picking the matching instance under the same mirror anchor as the active key. Single
  source of truth (the render walk), so it can't drift; flag-off / mirror-free it's the bare id.

## Scope

- **Path-based focus/caret:** `refs`, `pendingFocus`, `pendingFocusAtStart`, `pendingFlash`, and the
  `FocusPass` reverse-lookup must key off the **render path** for rows inside a mirror, not the bare node id
  (a node visible at two paths has two spans). `findFocusedId` resolves path → content id.
- **Caret nav** (`findVisibleNeighbor` / `buildVisibleRows` seq) operates on row addresses, so Arrow/Up-Down
  cross instance boundaries correctly.
- **Structural mutations redirect at the mirror boundary:** inserting a child *directly under a mirror* (or
  Enter-splitting / indent-outdent at the mirror's edge) must target the **source**, so the new node appears
  in every instance. Inside the subtree (real nodes) it already targets the real node — confirm.
- **Drag-reorder** (`use-drag-reorder.ts` / `virtual-nav.ts`): hit-test + projection by render path; dropping
  inside a mirror reorders the **real** nodes (and thus every instance). Document the surprise.
- **Multi-select** (`selection-state` / `selection-mode.tsx`): selection edges + `runMany` keyed by path; a
  run inside a mirror operates on the real nodes.

## Acceptance

- [x] Type, Enter-split, indent/outdent, Backspace-merge inside a mirror — caret lands correctly, and the
      same edit appears in every instance. *(2c: Enter-split + indent/outdent + delete in `mirror-editing.spec.ts`;
      type via 1b; backspace-merge rides the same key-addressed `onDeleteNode` + `findVisibleNeighbor` path.)*
- [x] Add a child directly under a mirror → it shows under the source and all other instances. *(2c)*
- [ ] Drag a sub-item inside a mirror → reorders under the source (verified in another instance). *(2d)*
- [ ] Multi-select + move/indent inside a mirror behaves as on real nodes; no cross-instance focus bleed. *(2e)*
- [x] The **same node visible at two paths simultaneously** (both homes on screen, e.g. top-level unzoomed):
      focusing one doesn't steal/echo into the other; both spans independent. *(2c: Enter-split focuses the
      windowed copy, asserts the source copy is NOT focused; content sync is by design, span identity is 2a.)*
- [x] Flag off → unchanged. New e2e spec `mirror-editing.spec.ts` green serial.

## Risk notes

This is where caret bugs hide. Budget for it. Stage 1 is landed and dogfooded (text + completed sync + view),
so the reference-grade behavior is proven in real use — this slice only adds editing *inside* the window.
The keystone (2a) is the regression risk; land it on its own commit behind the flag-off parity gate before
touching nav / structural / drag / select.
