# ADR 0007: Directional keyboard expand/collapse (Cmd+↓ / Cmd+↑)

Status: accepted (2026-06-21)

## Glossary

- **Collapsed** — a bullet whose subtree is hidden (`node.collapsed === true`). "Closed"
  in user-facing terms. "Open"/"expanded" means `collapsed === false`.
- **Has children** — the bullet has at least one visible child (`hasChildren` in
  `OutlineNode`, which already respects the "show completed" filter).
- **No-op** — the shortcut matched and its default was prevented, but no state changed.

## Decision

`Cmd/Ctrl+↓` and `Cmd/Ctrl+↑` expand and collapse the focused bullet. The binding is
**directional, not a toggle**: the key direction encodes the intent.

- **Cmd+↓** opens (reveals children of) a bullet that is *closed and has children*.
- **Cmd+↑** closes a bullet that is *open and has children*.
- Every other cell is a silent no-op (open+↓, closed+↑, childless either way).

It always acts **regardless of caret position**, and **one level only** (no recursive
deep-expand). Focus **stays on the parent** after expanding — you opened it to look, not
to edit the first child.

### The truth table

| State                  | Cmd+↓        | Cmd+↑        |
| ---------------------- | ------------ | ------------ |
| Closed, has children   | **open**     | no-op        |
| Open, has children     | no-op        | **close**    |
| No children            | no-op        | no-op        |

### The shortcut never moves the caret

Both combos **always `preventDefault`** inside the outline (they use the hotkey
manager's default options, unlike the bare arrows which opt out). The *action* is what's
conditional. So Cmd+↓/↑ never jump the caret to the end of the line the way macOS would
by default — they only ever expand, collapse, or do nothing.

## Why

- **Directional beats toggle under repeat-press.** Intent lives in the key, so holding
  Cmd+↓ can never accidentally re-collapse something. You never have to read current
  state to predict the result.
- **Always-preventDefault removes a footgun.** If the no-op cells fell through, the same
  key would sometimes expand and sometimes yank the caret to end-of-line — inconsistent
  and jarring. Overriding the macOS Cmd+↑/↓ caret-nav inside the outline is acceptable
  because Workflowy does the same and the whole app *is* the outline.
- **One level, focus-stays** matches the existing chevron click
  (`onToggleCollapsed(node.id, !node.collapsed)`), so keyboard and mouse agree.

## What changed

- Added `Mod+ArrowDown` and `Mod+ArrowUp` to the per-node `useHotkeys` array in
  `OutlineNode.tsx`, scoped to the bullet's contentEditable (`target: textRef`,
  disabled while the slash menu is open) like every other outline shortcut.
- Both reuse the existing `commands.onToggleCollapsed(id, collapsed)` mutation — no new
  command or state. `collapsed === false` opens, `collapsed === true` closes.

## Note

`Cmd+↑/↓` is the natural binding for a future *move-node-up/down* feature. This ADR
claims it for expand/collapse; if move-node lands, it supersedes this and collapse moves
to another key (e.g. `Cmd+Shift+↑/↓`). A future recursive deep-expand would similarly
take `Cmd+Shift+↓`.
