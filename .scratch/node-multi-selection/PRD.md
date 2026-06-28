# PRD: Node multi-selection

Status: proposed (designed, not started)
Decision record: [ADR 0030](../../docs/adr/0030-node-multi-selection.md). Serializer shared with
[ADR 0029](../../docs/adr/0029-markdown-export.md) (Ship 1).

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
- **Actions menu:** auto-appears anchored to the selection's top row, reuses `SlashMenuList`;
  `Escape` dismisses + clears.
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

- [ ] `selection-state.ts` — module singleton mirrored on `view-state.ts`; `getSelection()`,
      anchor/focus, subscribe; derive selected-root set + an `isSelected(id)` that accounts for
      subtree-implied descendants.
- [ ] `useIsSelected(id)` per-node subscription (shape of `useIsProtected`); wire the accent tint +
      rounded-block corners into `OutlineNode` row classes. Don't thread as props (ADR 0014).
- [ ] Keyboard: intercept `Shift+↑/↓`, `Cmd+A`, and the while-selected `↑/↓`/`Escape`/printable
      handling. Respect the existing reserved keymap (`Cmd+↑/↓` = expand/collapse,
      `Cmd+Shift+↑/↓` = move) — selection uses `Shift+arrow`, which is free.
- [ ] `CommandSpec.runMany?(rootIds, ctx)` in `plugins/types.ts`; registry surfaces the
      selection-command list; implement `runMany` for Move, todos To-do, daily Send to Today.
- [ ] Selection actions menu component (reuse `SlashMenuList`), anchored to the selection top.
- [ ] Copy as Markdown over roots (reuse `outlineToMarkdown`); Delete = loop `removeNode` over
      roots in one `runStructural`.
- [ ] e2e: shift-extend/shrink, Cmd+A ladder, delete, copy, menu `runMany`, escape/click clearing.

## Open implementation questions (resolve at build)

- Exact selection-tint token (eyeball both themes).
- Where the keyboard interception lives cleanly (bullet keymap vs a selection-mode handler) given
  caret/selection exclusivity.
- Menu re-anchor behavior while extending the selection upward.
