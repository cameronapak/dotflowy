# ADR 0009: Move a node among siblings (Cmd+Shift+↑ / Cmd+Shift+↓)

Status: accepted (2026-06-21)

## Glossary

- **Move** — relocating a bullet (and its whole subtree) up or down, as opposed to
  *indent/outdent* (`Tab`/`Shift+Tab`), which change depth, and *caret nav* (bare
  arrows), which only move the cursor.
- **Visible sibling** — a sibling that renders under the current "show completed"
  setting: `showCompleted || !node.completed`. The same filter `OutlineNode` uses to
  list children. A hidden completed sibling is **not** a move target.
- **Edge** — the focused node has no *visible* sibling in the move direction (it is the
  first or last visible child of its parent).
- **Boundary parent** — the current zoom root (`rootId`). A node directly under it must
  not escape the visible subtree, so an edge move there is a no-op.
- **No-op** — the shortcut matched and its default was prevented, but no state changed.

## Decision

`Cmd/Ctrl+Shift+↑` and `Cmd/Ctrl+Shift+↓` move the focused bullet up/down. ADR 0007
already reserved this binding for exactly this feature; this ADR **fulfils that
reservation** (it does not supersede 0007 — bare `Cmd+↑/↓` keeps expand/collapse).

Two behaviours, chosen by whether a visible sibling exists in that direction:

- **Has a visible sibling that way → swap with it.** Same depth, subtree carried along.
  Press repeatedly to march the bullet through its siblings, one slot per press. Hidden
  completed siblings are skipped (they ride along, staying hidden) so a press is never a
  dead no-visible-change move.
- **At the edge → outdent one level in that direction.**
  - **Up-edge:** the first visible child pops out to become the sibling **immediately
    before** its parent (promoted to the parent's level, landing above it).
  - **Down-edge:** the last visible child drops to become the sibling **immediately
    after** its parent — this is exactly the existing `outdent` mutation.

The move **always acts regardless of caret position**, **one level only**, and **focus
stays on the moved node** (you keep editing it). Both combos **always `preventDefault`**,
so Cmd+Shift+↑/↓ never trigger macOS "extend selection to document start/end" inside the
outline.

### The truth table

| State                                   | Cmd+Shift+↑           | Cmd+Shift+↓           |
| --------------------------------------- | --------------------- | --------------------- |
| Has visible sibling that way            | **swap with it**      | **swap with it**      |
| Edge, parent is a normal node           | **outdent before parent** | **outdent after parent** |
| Edge, parent is the zoom root (boundary)| no-op                 | no-op                 |
| Edge, already top-level (`parentId===null`) | no-op             | no-op                 |

## Why

- **Swap-then-pop-out is the predictable model.** Arrows = vertical position,
  `Tab`/`Shift+Tab` = depth. Keeping move about vertical order, and at the boundary
  doing the *minimal* depth change (pop out one level) to continue that direction, keeps
  the two mental models from colliding.
- **Never dive, never adopt.** A move restructures only the bullet you are on. We
  rejected two louder alternatives precisely because one keypress would restructure tree
  regions you are not looking at — see below.
- **Visible-order, not raw-order.** Moving must match what is on screen, same principle
  as ADR 0007 (`hasChildren` respects the filter) and ADR 0008 (caret nav off visual
  lines). Skipping hidden completed siblings avoids a press that visibly does nothing.
- **Down-edge reuses `outdent`.** The down-edge *is* the existing outdent semantics
  (become the sibling after the old parent), so keyboard move and `Shift+Tab` agree and
  we add no new relink logic for it.

### Rejected alternatives

- **Up-edge "adopt the following siblings" (the literal "become a parent").** Promoting
  the first child *and* re-parenting everything that followed it underneath the moved
  node. Rejected: one press silently restructures siblings you never touched.
- **Down-edge "dive into the next bullet's subtree."** Last child becomes the first
  child of the node below it. Rejected: pressing Down and landing nested inside a
  *different* parent (somewhere non-obvious if that parent has children) is a structural
  surprise that erodes trust in the key.
- **Down-edge = indent ("become a child").** The tempting read of "the opposite of
  become a parent." Rejected on purpose: making *Down* change depth inward collides with
  `Tab`'s job and breaks "arrows = vertical, tab = depth." Down must never mean *more
  nested*.

## Known rough edge

The **down-edge is the one weak spot**: when a last visible child outdents below its
parent, its *row position on screen does not change* — only its indent decreases. So
that single press can feel like "did Down do anything?" We accept it: the only
alternative that produces visible downward motion (diving into the next node) trades a
small confusion for a real structural surprise, and we prefer predictable-but-subtle
over lively-but-surprising. If it proves annoying in use, the one knob to turn is
flipping the down-edge to dive-into-next.

## What changed

- Added `moveUp(index, nodeId, opts)` and `moveDown(index, nodeId, opts)` to
  `src/data/mutations.ts`. `opts.isVisible` (the show-completed predicate) selects the
  swap target and detects the edge; `opts.rootId` is the boundary parent. Both operate
  on the `prevSiblingId` linked list: a swap detaches the node and re-inserts it before/
  after its visible neighbour (hidden siblings stay put and ride along); the up-edge uses
  a new `outdentBeforeParent` helper, the down-edge reuses `outdent`.
- Added `Mod+Shift+ArrowUp` / `Mod+Shift+ArrowDown` to the per-node `useHotkeys` array in
  `OutlineNode.tsx`, scoped to the bullet's contentEditable (`target: textRef`, disabled
  while the slash menu is open), using the default (always-`preventDefault`) options.
- Added `onMoveUp` / `onMoveDown` to `NodeCommands` and wired them in `OutlineEditor.tsx`
  with the same `capture` / `pendingFocus` / discard-on-no-op pattern as `onIndent` /
  `onOutdent`, passing the live `showCompleted` predicate and `rootId`.
