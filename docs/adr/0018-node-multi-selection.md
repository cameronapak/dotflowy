---
status: accepted
---

# Node multi-selection

**What.** A second editing mode where whole **nodes** are selected (distinct from selecting _text_
inside one bullet), so an action can act on several subtrees at once — copy-as-markdown today,
delete today, and indent/move/cut/paste later. Designed in full here; build plan in
`.scratch/node-multi-selection/PRD.md`. The first consumer is selection-copy, which reuses the
[ADR 0017](./0017-markdown-export.md) serializer verbatim.

**Model — sibling-scoped, subtree-implied.** A selection is a **contiguous run of siblings under
one parent**, and selecting a node **implies its whole subtree** (you select roots; descendants come
along). _Why not a free visual range across levels/parents?_ Because every operation on the list —
delete, indent, move, copy — only has an unambiguous meaning on a single-parent run. A visual range
makes "indent these into what?" and "move this run where?" undefined, and creates the paradox of
selecting a node together with its own descendant. Sibling-scoping is the deliberate simplification
of Workflowy's "shift+down just keeps going down visually," traded for operations that are never
ambiguous. The one allowed cross-level move is a **single-root** selection walking by depth at a
sibling boundary (climb to parent / dive to first child) — it's still exactly one subtree, so no
operation is ever ambiguous; the rejection is specifically of **multi-root** ranges that span parents.

**Caret and selection are mutually exclusive.** While nodes are selected there is no text caret;
while you have a caret you're editing one bullet. The transitions are the whole interaction:

- **Enter via `Shift+↑/↓`** from a focused bullet: anchor/focus model. The **first press selects
  ONLY the focused node** (it enters selection mode on that one node — direction-agnostic, the same
  as `Cmd+A` rung 2; it never extends to a sibling or jumps off the node). That node is the fixed
  **anchor**; **subsequent** Shift+arrow presses move the **focus** end, the selection being the
  inclusive sibling range between anchor and focus. Reversing direction **shrinks back toward the
  anchor** before extending the other way. At the first/last sibling a **multi-root** run can't
  extend further — that edge is a **no-op**, never jumping into another parent's run. A **single-root**
  selection instead **walks by depth** there: Shift+↑ selects the **parent**, Shift+↓ dives into the
  **first visible child** (climbing stops at the zoom root — the view root isn't a selectable node —
  and a collapsed/childless node can't dive). That keeps the selection one unambiguous subtree, so it
  is _not_ the rejected multi-parent visual range.
- **Enter via `Cmd+A` — a bounded 3-rung ladder:** (1) all text in the bullet (native), (2) this
  node + its subtree, (3) the whole current view (the zoom root's subtree). The rung is **derived
  from the current selection state, not a press counter** (counters desync the instant the user does
  anything between presses); an empty or already-fully-selected bullet skips rung 1. There is
  **deliberately no per-level climb** — `Cmd+A` is the big-jump scope tool, `Shift+arrow` is the
  surgical sibling tool, and overlapping them (both doing sibling-level work) was the rejected
  design.
- **While selected:** plain `↑/↓` drops the caret onto the visible row just _above the top_ / _below
  the bottom_ of the selection (the existing visual neighbor walk — caret motion is visual even
  though selection is sibling-scoped). `Tab`/`Shift+Tab` **indent/outdent the whole run** (see
  Operations); the selection **persists** so you can keep nudging. A printable `[a-zA-Z]` key is a
  **no-op; the selection persists** — it must **never** replace-on-type the way a text editor does,
  or a stray keypress would delete whole subtrees. `Escape` clears → caret returns; a click clears →
  normal edit.

**Operations (this ADR's v1):** **Copy as Markdown** (`Cmd+C`, reuses the ADR 0017 serializer over
the selected roots), **Delete** (`Backspace`/`Delete`, `removeManyNodes` over the selected roots
inside one `runStructural` batch), and **Indent / Outdent** (`Tab` / `Shift+Tab`, `indentManyNodes` /
`outdentManyNodes`). Indent moves the run under the first root's previous sibling; outdent lands it
immediately after its former parent (a no-op at the zoom-root boundary). Both are one `runStructural`
batch and **keep the selection** (`refreshSelection` re-derives the run's new parent so the next
nudge reads accurate state). **Deferred:** drag, cut, paste — paste needs a node-clipboard format and
insertion logic that doesn't exist, and drag is a single-node imperative system
(`use-drag-reorder.ts`) that needs real surgery to carry a selection.

**The actions menu, and `runMany`.** When a selection exists, a menu **auto-appears anchored to the
active (focus) edge — the newest node a `Shift+arrow` just added — and re-anchors to it on every
extension**, so it tracks the node you're selecting instead of parking over the run's text.
**Positioning is delegated to floating-ui** (`@floating-ui/react-dom` — the same engine Base UI uses):
its preferred side is the **outer edge** of the run (below the focus row when the run grows down,
above when it grows up; below for a lone single node) so it stays off the selected text, while
`flip()` + `shift()` keep it **fully on screen at any viewport edge** — flipping below the top node
rather than clipping off-screen — and `autoUpdate` re-solves on scroll/resize. The focus row itself
is kept on screen with a stock `el.scrollIntoView({ block: "nearest" })`, since selection extension
never focuses a row (caret and selection are mutually exclusive, so nothing else scrolls it). It
reuses `SlashMenuList`, which is now **presentational only** — the caller owns positioning (the slash
menu fixes itself at the caret; this menu hands floating-ui the focus row as the reference), so
neither reinvents collision geometry. `Escape` dismisses and clears. It lists core **Copy** +
**Move** + **Delete** plus every plugin command that opts in. A single-node
`CommandSpec.run(nodeId, ctx)` **cannot** simply be looped over a set — `Move` opens a destination
picker (looping fires N dialogs) and daily's "Send to Today" navigates (looping navigates N times).
So `CommandSpec` gains an **optional `runMany(rootIds, ctx)`**, mirroring how `available(node)`
already gates per-node fitness: the selection menu shows **only** commands that define it, and each
plugin **explicitly declares its command is set-aware and how** (`Move` → one dialog, N moves;
todos' To-do → batch `setIsTask`; daily's Send to Today → one batch + one nav). `runMany` receives
the **selected root ids only** (subtrees implied).

**Implementation invariants (don't regress these):**

- Selection state is a **module singleton mirrored like `view-state.ts`**; each row reads a per-node
  **`useIsSelected(id)`** (the shape `useIsProtected` already uses), so a selection change
  re-renders only the rows entering/leaving it — preserving the per-node-render guarantee of
  [ADR 0014](./0004-localized-rendering-via-the-tree-store.md). **Don't** thread selection as props.
- Every multi-node mutation (delete, future move/indent) goes through **one `runStructural` batch**
  ([ADR 0009](./0009-atomic-structural-writes.md)) — never a loop of independent writes.

**Visual.** The contiguous selected block (selected roots + every descendant row) gets a subtle,
theme-aware accent/selection tint at **full row width**, with the **outer corners rounded** (top of
the first row, bottom of the last) so it reads as one slab, not a stack of stripes. Text stays
normally rendered (it isn't natively selected) and must stay readable on the tint; no marker on the
moving (focus) edge; composes with the faded/completed and filter-dimmed states. The exact token
(`accent` vs a `primary` tint vs a dedicated `--selection`) is a polish call made by eye in both
themes at build time.

**Don't:** use a multi-root visual-flatten range that spans parents (a single-root depth walk at a
boundary is fine — it stays one subtree); loop `run(nodeId)` over a set; let typing replace a
selection; thread selection through props; or route the batch delete outside `runStructural`.
