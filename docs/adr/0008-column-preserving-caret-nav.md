# ADR 0008: Column-preserving cross-node caret navigation

Status: accepted (2026-06-21)

## Glossary

- **Visual line** — one rendered row of a bullet. A short bullet is one visual line; a
  long one wraps to several. Distinct from text offset: caret offset 0 can sit on the
  last visual line (a single-line bullet) or the first (a wrapped one).
- **Column** — the caret's horizontal position, measured as a viewport **x** pixel, not a
  character index. "Preserve the column" means land at the same x in the neighbor.
- **Cross / crossing** — Up/Down moving the caret out of one bullet and into a neighbor,
  as opposed to moving between visual lines inside the same wrapped bullet.

## Decision

Arrow Up/Down crosses to a neighbor bullet only from the **edge visual line**, and the
landing caret **preserves the column**.

1. **Cross from the edge line, not the text edge.** Up crosses when the caret is on the
   *first* visual line; Down crosses when it's on the *last*. On a single-line bullet
   that's true at any offset, so a single press always crosses. Inside a wrapped bullet,
   line-1 ↔ line-2 movement is left to the browser default. (Detected by comparing the
   caret's rect to the element's rect, not by text offset — see `atLineStart`/`atLineEnd`
   in `OutlineNode.tsx`.)

2. **Preserve the column on landing.** The caret lands at the same viewport x it left,
   on the line nearest the entry side: the **top** line coming Down, the **bottom** line
   coming Up. Column-0 → column-0 is just the common case of this rule.

3. **Read the layout from the DOM, no measurement library.** The bullets are real
   `contentEditable` DOM, so the browser has already laid the text out. We capture the
   caret's x from its `Range` rect on keydown, then ask the browser which character sits
   at `(x, edge-line-y)` in the neighbor via `caretPositionFromPoint`
   (`caretRangeFromPoint` fallback on WebKit). Missing x (e.g. the zoom title) or a probe
   that misses the text falls back to start/end.

## Why

- **Matches Workflowy.** Column preservation is the behavior users expect from an
  outliner; landing at start-of-node (the previous behavior) felt like a teleport,
  especially pressing Up.
- **Visual-line, not text-offset, is the correct cross test.** The old offset test
  (`offset === length`) made Down a no-op-then-browser-default on a single-line bullet
  whose caret sat at offset 0 — the caret slid to end-of-line instead of crossing. The
  rect test fixes that without breaking intra-bullet line movement on wrapped text.

## Rejected: a text-layout library (`@chenglou/pretext`)

`pretext` measures and lays out multiline text in pure JS **without the DOM** — built for
canvas/virtualized/custom text engines. Wrong fit here:

- Our text is already in `contentEditable` DOM; the browser has the authoritative layout.
  `pretext` would re-derive it, with a real risk its wrapping doesn't match the browser's
  pixel-for-pixel — and a mismatch puts the caret in the wrong place.
- `caretPositionFromPoint` answers exactly the question we have ("what offset is at this
  x/y") natively, with zero dependency.

It would earn its place only if we stopped using `contentEditable` and rendered the
outline ourselves (canvas, virtualization). We don't.
