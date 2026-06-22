# ADR 0010: Drag to reorder and reparent (pointer + touch)

Status: accepted (2026-06-22), implemented

## Glossary

- **Drag-move** — relocating a bullet (and its whole subtree) by pointing: pressing on
  its bullet dot and dragging to a new spot. Distinct from *keyboard move* (ADR 0009),
  which only ever changes vertical order or pops out one level at an edge.
- **Fused move** — the single operation a drop performs: it sets both the node's new
  parent *and* its new position among siblings at once. The keyboard deliberately refuses
  to expose this (it keeps order and depth on separate keys); drag exposes it on purpose.
  See *Why a drag may fuse what keys may not*.
- **moveNode** — the one new mutation: `moveNode(index, nodeId, newParentId, afterSiblingId)`.
  Relinks the `prevSiblingId` chain to detach the node from its old slot and splice it into
  the new one. Everything in this ADR reduces to one call to it.
- **Grabbed node** — the bullet being dragged. Its subtree is carried with it and
  *collapses to a single row* for the duration of the drag, restoring on drop.
- **Floating pill** — the visual of the grabbed node while dragging: a highlighted row
  that follows the pointer (the Workflowy treatment).
- **Drop gap** — the position between two rendered rows (or above the first / below the
  last) where the node will land. The pointer's *vertical* position picks the gap.
- **Target depth** — the indent level the node will land at within a gap. The pointer's
  *horizontal* position picks it, snapped to the legal range.
- **Legal depth range** — for a gap between the row above (`A`) and the row below (`B`),
  the set of allowed target depths is `[depth(B), depth(A) + 1]`, then clamped so the
  node stays inside the current zoom (no shallower than a direct child of `rootId`).
- **Drop indicator** — a thin horizontal line drawn at the drop gap; its **left edge is
  indented to the target depth**, so the indent itself is the depth feedback.
- **Boundary parent** — the zoom root (`rootId`), same meaning as ADR 0009. Drag operates
  only within the rendered (zoomed) tree; a node cannot be dropped out of it.

## Decision

A bullet can be relocated by dragging its **bullet dot** with mouse or touch. A drag
performs one **fused move**: `moveNode(node, newParentId, afterSiblingId)` sets the new
parent and the new sibling position together.

### Why a drag may fuse what keys may not

ADR 0009 built a wall: **arrows = vertical order, Tab = depth**, and explicitly rejected
any key that changes both at once. Drag breaks that wall on purpose, and that is correct
because **the modality changes the contract**. A keypress carries one bit of intent, so
fusing depth and order onto one key would be ambiguous. A drop carries an exact pixel:
the pointer names a gap *and* an indent, so resolving both from one gesture is honest.
The keyboard model is left completely undisturbed.

### The unit, and what happens mid-drag

You drag a **node plus its entire subtree**. While dragging, the subtree **collapses to a
single row** (the floating pill), so you are moving one compact thing rather than a tall
block, and it **restores its prior expand/collapse state on drop**.

### How a drop resolves to parent + position

1. The pointer's **vertical** position picks the **drop gap** (between two rendered rows).
2. The pointer's **horizontal** position picks the **target depth**, snapped to the
   **legal depth range** `[depth(below), depth(above) + 1]`. The snap is **biased toward
   the shallower level** (`NEST_RESISTANCE`): you must travel most of an indent rightward
   to nest one level deeper, so a near-vertical drag holds sibling depth instead of
   slipping under the row above. Shedding depth (moving left) stays unbiased.
3. Depth is then **clamped to the boundary**: never shallower than a direct child of the
   current zoom root. (When zoomed all the way out, `rootId === null`, the floor is
   top-level — no clamp bites.)
4. Target depth + gap together determine `newParentId` and `afterSiblingId`, which is the
   single `moveNode` call.

Reparenting to **any node on screen** is allowed: drag into a sibling's subtree, out to a
shallower level, anywhere the legal range reaches.

### Invariants (the truth table)

| Situation                                                  | Behavior |
| ---------------------------------------------------------- | -------- |
| Drop target is the grabbed node or inside its own subtree  | **Illegal** — indicator turns off; no move on release |
| Target depth shallower than a direct child of `rootId`     | **Clamped** to direct-child depth (can't leave the zoom) |
| Drop onto / just under a **collapsed** parent              | Allowed; the parent **expands on drop** so the result is visible |
| A sibling at the gap is a **hidden completed** node        | **Ignored** — drag lands exactly at the pointer; the visible-filter does not apply |
| Drop in the **whitespace below the list**                  | Lands as the **last child of `rootId`** (top-level when not zoomed) |
| Release without crossing the drag threshold                | **No move**; treated as a click on the dot → **zoom** |

### Trigger and touch

- **The dot is the handle.** Click the dot = zoom (unchanged, ADR 0003). Press-and-drag
  the dot past a small movement **threshold** = move. A release that never crossed the
  threshold must fire the **zoom**, not a no-op move, so the dot keeps both jobs.
- **Touch starts the drag immediately** from the dot — no long-press. A touch that begins
  on the dot lifts the node; a touch anywhere else scrolls the page as normal. The dot is
  a small, intentional target, so it disambiguates scroll-vs-move without a press delay.

### Feedback

- **Drop indicator:** a thin horizontal line at the drop gap; its left edge is **indented
  to the target depth**. The indent *is* how horizontal position reads back to the user.
- **Floating pill:** the grabbed (collapsed) row follows the pointer.
- **Auto-scroll:** when the pointer nears the top or bottom viewport edge mid-drag, the
  view scrolls so off-screen targets in a long outline are reachable. Required for the
  feature to be usable on a real outline; it is the one piece safe to land in a fast
  follow if the first cut ships without it.

### Undo

One drag = **one undo step**: `capture` the pre-drag state, run `moveNode`, done. Same
`capture` / `pendingFocus` / discard-on-no-op pattern as `onMoveUp`. Nothing fancier (no
separate undo entry for the mid-drag collapse).

## Why

- **Direct manipulation earns the fused move.** The pointer supplies the exact gap and
  indent a key can't, so a drop legitimately sets parent and order together without
  reopening the keyboard's order-vs-depth split.
- **`[depth(below), depth(above)+1]` is the only range that's never surprising.** You can
  land as deep as "first child of the row above" or as shallow as "sibling of the row
  below," and nothing in between is illegal. Anything outside would drop the node at a
  depth that has no visual anchor at that gap.
- **Drag ignores the visible-filter; keyboard respects it.** ADR 0009 skips hidden
  completed siblings because a *keypress needs a visible effect*. A drag has a real cursor
  at a real pixel, so it must land exactly where pointed — applying the filter would make
  it land somewhere other than where the user aimed.
- **Expand-collapsed-on-drop preserves trust.** Dropping into a black box and watching the
  node vanish is the kind of thing that makes people stop trusting the gesture. Expanding
  shows the result.
- **One handle (the dot) beats a second affordance.** Touch has no hover, so a hover-only
  grip would have to be permanently visible on touch devices — gutter clutter for every
  row. Reusing the dot keeps mouse and touch identical with zero new chrome.

## Rejected alternatives

- **Order-only drag (reorder within current parent, never reparent).** Would preserve the
  ADR 0009 wall perfectly. Rejected: reparenting by drag is the single most expected thing
  about dragging an outline node; withholding it to protect a keyboard-only invariant
  helps no one.
- **A separate drag grip in the gutter.** Clean click/drag separation. Rejected: invisible
  on touch without being always-shown, and always-shown means permanent clutter. The dot
  already affords "grab me."
- **Long-press to lift on touch.** The iOS-reorder pattern. Rejected: adds latency to
  every single move, and the dot is a precise enough target that scroll-vs-move
  disambiguates on contact.
- **Breadcrumb crumbs as drop targets (drag a node out of the zoom).** Rejected: adds a
  whole second drop surface for a rare move. Escaping a zoom is what zoom-out plus the
  existing keyboard outdent are for.
- **Depth chosen by which row you hover rather than horizontal x.** Rejected: at a gap
  between a deep row and a shallow row, hover alone can't express the intermediate depths
  the legal range allows; horizontal position can.
- **Pull in a drag library (e.g. dnd-kit).** Rejected: its sortable preset doesn't do
  tree reparenting, so we'd still hand-write depth-from-x; it imports React, which trips
  the documented stale-Vite-dep crash (see AGENTS.md); and the move mechanics are already
  `prevSiblingId` relinks that fit this editor's hand-rolled style.

## Known rough edges

- **Threshold tuning.** The dot does double duty (click = zoom, drag = move). The movement
  threshold and a "did we actually move" guard must keep a sloppy click from triggering a
  no-op move, and keep a real drag from also firing a zoom on release. This is the one
  fiddly interaction knob.
- **No test runner.** `typecheck` is the only static gate (AGENTS.md). Drag-drop is exactly
  where edge cases hide, so the edge list below must be walked by hand: drop on self, drop
  into a collapsed parent, drop at the very top/bottom, drop in empty whitespace, drag near
  a hidden completed sibling, drag while zoomed (boundary clamp), drag on touch.

## What changed

- **`moveNode(index, nodeId, newParentId, afterSiblingId)`** in `src/data/mutations.ts`.
  Detach: repoint the node's old next sibling to its old `prevSiblingId` (same relink
  `removeNode` does). Reattach: set `parentId` + `prevSiblingId`, then repoint whatever
  followed the new slot. Rejects (returns false) when `afterSiblingId`/`newParentId` is the
  node itself, when the target is inside the node's own subtree (cycle guard walks
  `parentId` up from the target), and on a true no-op (same parent, same predecessor).
- **`src/components/use-drag-reorder.ts`** — a `useDragReorder` hook driving the gesture
  imperatively (no React state on the hot path). `pointerdown` arms a 5px threshold;
  crossing it dims the source row, hides its subtree (a CSS class, no data change), and
  spawns a floating pill + drop indicator on `document.body`. Each `pointermove` rebuilds
  the visible rows from the index, resolves the drop gap (pointer y) and target depth
  (pointer x, clamped to `[depth(below), depth(above)+1]`), and positions the indicator.
  An rAF loop auto-scrolls near the viewport edges. `pointerup` commits via `onMove` and
  flags the click as consumed.
- **`OutlineNode.tsx`** — the bullet dot now wires `onPointerDown → onBulletPointerDown`
  and `onClick → onBulletClick` (added to `NodeCommands`). The boundary clamp falls out of
  the relative-depth model for free: depth 0 is a direct child of `rootId`, so a drop can
  never land shallower than the current view.
- **`OutlineEditor.tsx`** — instantiates the hook with getters over the live refs;
  `onMove` runs `capture` → `moveNode` → `pendingFocus` (discard the undo point on a
  no-op), and `onBulletClick` zooms only when `consumeClick()` reports no drag happened. A
  `listRef` on the top `<ul>` gives the indicator its right edge.
- **`styles.css`** — `.bullet { touch-action: none }` so a touch on the dot is a drag, not
  a scroll; plus `.drag-source`, `.drag-collapsed`, `.drag-pill`, `.drag-indicator`, and
  `body.dragging-active`.
