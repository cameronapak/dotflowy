# ADR 0002: Completion fade cascade and "Show completed" toggle

Status: accepted (2026-06-21)

Builds on [ADR 0001](./0001-completion-is-independent-of-task.md): `completed` is an
independent boolean on every bullet.

## Glossary

- **Faded** — a bullet rendered at reduced opacity (more transparent), the visual
  signal that it is done or lives under something done. The whole row fades as one
  unit: bullet dot, checkbox, and text together. Not to be confused with *opaque*
  (the opposite — fully solid).
- **Strikethrough** — line-through on the text. Distinct from *faded*: strikethrough
  marks a bullet that is itself completed; fading can also be inherited.
- **Completed subtree** — a completed bullet plus all its descendants, regardless of
  each descendant's own `completed` value.
- **Show completed** — a single global, persisted UI toggle. When off, every
  completed subtree is hidden from the outline.

## Decisions

### 1. The fade is visual-only. It never mutates child data.

Completing a parent does **not** set `completed: true` on its descendants. Each
bullet keeps its own done-status. Uncompleting the parent restores the children's
individual appearance untouched. (Considered and rejected: cascading the boolean
into descendants — it destroys real per-child state.)

### 2. A bullet is faded iff itself, or any ancestor *within the current view*, is completed.

Computed at render by walking down from the current root, carrying a single
"an ancestor is completed" flag. No data, no derived field.

### 3. No compounding. One fade level, any depth.

A completed child under a completed parent looks identical to a single completed
bullet — one opacity step, not stacked. The implementation must avoid nesting CSS
`opacity` (which multiplies down the DOM); apply the fade per-row, gated by the
inherited flag, not on the container.

### 4. Faded bullets stay fully interactive.

Editable, focusable, zoomable, collapsible. Fade is appearance only; it changes
nothing about behavior.

### 5. Strikethrough is self-only and text-only.

- Completed bullet: faded row **and** strikethrough text.
- Faded-by-ancestor child (not itself completed): faded row, **no** strikethrough.

### 6. The fade cascade stops at the zoom root.

When zoomed in, the root is the whole world. Its children are evaluated on their
own `completed` state only — a completed ancestor *above* the root (now off-screen)
contributes nothing. The root's title shows completed styling only if the root
itself is completed.

### 7. "Show completed" is one global, persisted boolean.

- Lives in the app header (alongside the theme toggle), like Workflowy.
- Persisted to `localStorage`; survives reload; applies to every view and zoom level.
- When **off**, any completed bullet and its entire subtree are hidden — including
  *incomplete* children of a completed parent (they vanish with the parent).
- Stored under its own key, separate from the nodes collection. It is UI state, not
  document data.

## Why

Completion fading is how an outline shows "done without deleting." Making it a pure
render concern (decisions 1, 2) keeps the data model honest and reversible. The
single-level, whole-row fade (3, 5) reads as one clear "done" state instead of a
murky depth gradient. Stopping at the zoom root (6) keeps a zoomed branch usable.
"Show completed" (7) is the escape hatch for when even faded clutter is too much.
