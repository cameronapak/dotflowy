# PRD: Node multi-selection

Status: Ship 2 shipped + Ship 2.1 (menu follows the active edge); Ship 3 deferred. ADR 0018 accepted.
Decision record: [ADR 0018](../../docs/adr/0018-node-multi-selection.md). Serializer shared with
[ADR 0017](../../docs/adr/0017-markdown-export.md) (Ship 1).

## Why

The editor can select text inside one bullet, but not whole nodes. Multi-node selection unlocks
acting on several subtrees at once: copy-as-markdown, delete, and later indent/move/cut/paste. It's
the larger sibling of the markdown-export feature — export is its first consumer.

## Locked design (from the grill)

- **Model:** sibling-scoped, contiguous run under ONE parent; selecting a node implies its subtree.
- **Caret vs selection:** mutually exclusive. No text caret while nodes are selected.
- **Enter:**
  - `Shift+↑/↓` from a caret — anchor/focus, shrink-toward-anchor-then-extend, boundary no-op
    (never crosses parents).
  - `Cmd+A` 3-rung ladder: text (native) → this node + subtree → whole current view. Rung derived
    from current selection state, not a counter; empty/all-selected bullet skips rung 1. No
    per-level climb (that's `Shift+arrow`'s job).
- **While selected:** plain `↑/↓` → caret to visible row above-top / below-bottom; `[a-zA-Z]` →
  no-op, selection persists (NEVER replace-on-type); `Escape` → clear + caret; click → clear + edit.
- **Visual:** subtle theme-aware accent tint across every row of the selected subtrees, full row
  width, rounded outer corners (one slab); no focus-edge marker; composes with faded/filter states.
- **Actions menu:** auto-appears anchored to the **active (focus) edge** (the newest node a
  `Shift+arrow` just added), re-anchoring on every extension; positioned by **floating-ui**
  (preferred outer side, `flip()`/`shift()` keep it fully on screen at any edge); the focus row is
  kept visible with a stock `scrollIntoView`. Reuses `SlashMenuList` (presentational only); `Escape`
  dismisses + clears.
- **`runMany(rootIds, ctx)` opt-in** on `CommandSpec`; selection menu shows core Copy + Delete plus
  every command that defines `runMany`. Operates on selected ROOT ids.

## Scope

**Ship 2 (this PRD) — v1 operations:**
- Selection model + `Shift+arrow` + `Cmd+A` ladder
- Visual treatment
- Copy as Markdown (`Cmd+C`, reuses the Ship-1 serializer)
- Delete (`Backspace`/`Delete` + menu action)
- Actions menu + `runMany` on Move (core), To-do (todos), Send to Today (daily)

**Ship 3 — deferred:** Tab indent/outdent, drag a multi-selection, cut, paste (needs a
node-clipboard format + insertion logic; drag needs `use-drag-reorder.ts` surgery).

## Build checklist (Ship 2)

- [x] `selection-state.ts` — module singleton mirrored on `view-state.ts`; anchor/focus,
      subscribe; derives the selected-root run + per-root slab `SelectionEdge`. (Selection is
      sibling-scoped and the root's `<li>` background tints its subtree, so `useSelectionEdge`
      marks only roots — descendants come along visually, no per-descendant set needed.)
- [x] `useSelectionEdge(id)` per-node subscription (shape of `useIsProtected`); wires the
      slab tint + rounded outer corners onto the `OutlineNode` `<li>` via `data-selected`. Not
      threaded as props (ADR 0014).
- [x] Keyboard: `Shift+↑/↓` enter (`use-bullet-keymap`), `Cmd+A` ladder rung 1→2 there + rung 3
      in the while-selected window handler (`selection-mode.tsx`), and the while-selected
      `↑/↓`/`Escape`/printable/`Cmd+C`/`Backspace`. Reserved keys respected (`Cmd+↑/↓` = expand,
      `Cmd+Shift+↑/↓` = move); selection uses the free `Shift+arrow` + `Mod+A`.
- [x] `CommandSpec.runMany?(rootIds, ctx)` in `plugins/types.ts`; registry surfaces
      `selectionCommandSpecs`; `runMany` implemented for Move (core, multi-target move dialog),
      todos To-do (batch `setIsTask`), daily Send to Today (one batch + one nav).
- [x] Selection actions menu (`SelectionActionsMenu`, reuses `SlashMenuList`), anchored to the
      **active (focus) edge** via live DOM (`data-node-id`), positioned by floating-ui
      (`flip`/`shift`/`autoUpdate`) so it stays on screen; `scrollIntoView` keeps the focus row
      visible. `SlashMenuList` is now presentational only. [Ship 2.1]
- [x] Copy as Markdown over roots (reuses `outlineToMarkdown`); Delete = `removeManyNodes` over
      roots in one `runStructural` (rebuild-per-delete keeps the sibling chain intact).
- [x] e2e (`e2e/node-multi-select.spec.ts`): shift-extend/shrink, boundary no-op, Cmd+A ladder,
      copy (clipboard round-trip), delete + undo, printable no-op, escape/click clearing, menu
      To-do `runMany`.

## Ship 2 notes (as built)

- The slab is painted on the selected ROOT's `<li>` (its background sits behind the whole
  subtree), so only roots carry a `data-selected` edge; contiguous roots merge because sibling
  `<li>`s have `margin:0`. Tint is `oklch(from var(--primary) l c h / 0.1)` (adapts to both themes).
- Caret↔selection exclusivity is enforced by clearing the selection on any bullet/title `onFocus`
  and on a window `mousedown` outside the actions menu; the while-selected keys live on a
  capture-phase `window` listener (no caret is focused in selection mode).
- The actions menu anchors via `document.querySelector` on `data-node-id`, NOT the refs Map: the
  bullet span's ref is an inline arrow (re-attaches each commit), so a layout-effect read of the
  Map can race the re-attach. (Caught in e2e.)
- Multi-node Move/Send-to-Today/Delete rebuild the index from the live collection between each
  `moveNode`/`removeNode` (`moveManyNodes`/`removeManyNodes`), because looping over a stale
  snapshot tears the sibling chain when the operated nodes are siblings of each other.

## Ship 2.1 notes (menu follows the selection, stays on screen)

- The actions menu anchors to the **focus** edge, not the top row, so it tracks the node you're
  adding. Side is derived stateless from focus-vs-anchor order (`focusId === rootIds[last]` →
  `bottom-start`, else `top-start`; single node → `bottom-start`) and handed to **floating-ui** as
  the preferred placement.
- **floating-ui owns the geometry** (`@floating-ui/react-dom`, already in the tree via Base UI):
  `offset(6)` + `flip({padding:8})` + `shift({padding:8})` + `autoUpdate`. `flip`/`shift` keep the
  menu fully on screen at any edge (it flips below the top node instead of clipping off the top —
  the reported bug); `autoUpdate` re-solves on scroll/resize. This **replaced** a hand-rolled
  `window.scrollBy` reserve, manual above/below math, an `itemCount*44` height estimate, and a
  `[data-editor-chrome]` header measurement — all of which floating-ui does better, and the
  `scrollBy` reserve couldn't fix the document-top boundary at all.
- The focus row is kept visible with a stock `el.scrollIntoView({ block: "nearest" })` (selection
  extension never focuses a row — caret/selection exclusivity — so nothing else scrolls it).
- `SlashMenuList` is now **presentational only**: the caller passes `style`/`ref`, owning
  positioning. The slash menu fixes itself at the caret; the selection menu hands the floating
  element to floating-ui. Neither reinvents collision geometry.
- **Trade-off:** at the top boundary the menu flips *below* the focus node to stay on screen, so it
  can overlap the selected rows there. "Always visible" wins over "never covers text" only at that
  edge (rare); elsewhere the outer-side rule keeps it off the text.

## Resolved open questions

- Exact selection-tint token: `oklch(from var(--primary) l c h / 0.1)` (Ship 2).
- Keyboard interception location: enter in `use-bullet-keymap`, while-selected in `selection-mode`
  (Ship 2).
- Menu re-anchor while extending upward: anchors to the focus edge, preferring **above** it when the
  run grows up, and floating-ui flips it **below** at the top boundary to stay on screen (Ship 2.1).
