---
status: accepted
---

# Horizontally scrollable outline canvas

**What.** Deeply nested visible nodes stop shrinking once their body would
become unreadable. The outline content column owns a horizontal **outline
canvas** whose width grows with visible depth; the page and fixed header do not
scroll sideways. The window remains the vertical scroll surface required by
ADR 0019.

The canvas width is at least the viewport content width. When necessary it grows
to `deepest visible depth × 24px + minimum readable node body`, including the
row's existing control reserves. The minimum body width follows the three
device-local reading-size steps from ADR 0029, but an individual node body never
becomes wider than the viewport's content column. Exact Small, Default, and
Large values are visual tuning constants, not an architectural contract: test
them at narrow and desktop widths and several depths before settling them.

An Embed body uses its node's own bounds at every depth: its left edge aligns to
that node's content edge and its right edge aligns to the node's normal
content edge. It never breaks out to viewport gutters. A zoomed node starts at
depth zero and therefore uses the ordinary content width.
If an official provider has a larger minimum width, its owning row grows within
the canvas rather than clipping the widget. X requires at least 250px of content
width, plus the row's existing control reserves.

**Reveal behavior.** Keyboard focus, caret navigation, Cmd+K, mirror jumps, and
programmatic focus scroll the minimum horizontal distance needed to reveal the
whole target body. They do not center it. Expanding a branch preserves the
horizontal offset. Clicking or tapping visible text or row controls does not
reveal the rest of the row. Collapsing a branch preserves the current offset
where possible and clamps it to the remaining canvas. After clamping, minimally
reveal the focused parent only if it is completely outside the viewport; never
leave an apparently empty viewport. Changing the zoom root resets horizontal
position to the left gutter.
Back navigation minimally reveals the node that led to the zoomed view rather
than maintaining per-route horizontal scroll state.

**Pointer and touch behavior.** A touch beginning on row text or empty row space
uses native direction locking for horizontal canvas panning or vertical window
scrolling. A bullet tap zooms; a swipe beginning on the bullet also pans or
scrolls. To reorder with touch, hold for 350ms within the existing 5px movement
threshold, then move. Earlier movement cancels the pending drag and leaves
scrolling to the browser. The bullet permits native panning and pinch zoom;
a non-passive touchmove listener prevents panning only after the hold. A second
finger or pointer cancellation abandons the drag. Mouse and pen retain the
5px movement threshold without a hold.

A touch drop flashes the landing row without requesting editor focus. The
gesture's pointer type decides this, not the device's primary pointer, so a
mouse on a touch-capable device retains desktop focus behavior. Tapping text
or row dead space still edits as specified in ADR 0029; this is not a browse
mode. Drop geometry, sibling order, and no-op history rollback are unchanged.

Provider frames and other interactive children keep their own gestures.
During drag reorder, nearing either horizontal edge auto-scrolls
the canvas while projected depth continues to change in the existing 24px
steps.

Native touch, trackpad, and Shift-wheel scrolling ship with subtle directional
edge fades when more canvas exists. Do not build a synchronized sticky
scrollbar before real mouse-only use proves it necessary. Menus and overlays
opened from a row portal outside the canvas so overflow cannot clip them.

**Why not viewport-wide Embed breakouts.** They make a top-level mobile Embed
look wide, but a nested body escapes the node that owns it and overlaps sibling
depth. They also hide the real failure: the whole row is being compressed by
indentation. Protecting node width at the canvas level fixes text, controls, and
all Embed providers with one ownership rule.

**Implementation constraints.** Keep `INDENT_PX = 24` as the single source for
rendering, drag projection, and canvas width. Preserve the flat, windowed list:
each virtual row still measures its full body and remains a direct child of the
list. A row caps at the viewport content width plus its own indent, so a shallow
row does not grow merely because a deeper sibling expands the canvas. The
horizontal owner must hide, not scroll, vertical overflow; otherwise CSS turns
it into a second vertical scroll container and fights window virtualization.
Canvas-width changes must not fork visible-order traversal. Width and edge-state
updates should follow visible structure and resize events, not text keystrokes.

**Rejected alternatives.** Page-level horizontal scrolling moves unrelated
chrome. Allowing arbitrary shrinkage makes text and providers unusable. Giving
only Embed bodies a viewport breakout violates nesting and leaves ordinary
nodes unreadable. Per-branch or per-route horizontal scroll memory adds state
without solving a demonstrated problem. A custom sticky scrollbar is deferred,
not prohibited.
