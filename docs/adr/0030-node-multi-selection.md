---
status: proposed
---

# Node multi-selection

**What.** A second editing mode where whole **nodes** are selected (distinct from selecting *text*
inside one bullet), so an action can act on several subtrees at once — copy-as-markdown today,
delete today, and indent/move/cut/paste later. Designed in full here; build plan in
`.scratch/node-multi-selection/PRD.md`. The first consumer is selection-copy, which reuses the
[ADR 0029](./0029-markdown-export.md) serializer verbatim.

**Model — sibling-scoped, subtree-implied.** A selection is a **contiguous run of siblings under
one parent**, and selecting a node **implies its whole subtree** (you select roots; descendants come
along). *Why not a free visual range across levels/parents?* Because every operation on the list —
delete, indent, move, copy — only has an unambiguous meaning on a single-parent run. A visual range
makes "indent these into what?" and "move this run where?" undefined, and creates the paradox of
selecting a node together with its own descendant. Sibling-scoping is the deliberate simplification
of Workflowy's "shift+down just keeps going down visually," traded for operations that are never
ambiguous.

**Caret and selection are mutually exclusive.** While nodes are selected there is no text caret;
while you have a caret you're editing one bullet. The transitions are the whole interaction:

- **Enter via `Shift+↑/↓`** from a focused bullet: anchor/focus model. The start node is the fixed
  **anchor**; Shift+arrow moves the **focus** end; the selection is the inclusive sibling range
  between them. Reversing direction **shrinks back toward the anchor** before extending the other
  way. At the first/last sibling, Shift toward that edge is a **no-op** — it never jumps into
  another parent's run.
- **Enter via `Cmd+A` — a bounded 3-rung ladder:** (1) all text in the bullet (native), (2) this
  node + its subtree, (3) the whole current view (the zoom root's subtree). The rung is **derived
  from the current selection state, not a press counter** (counters desync the instant the user does
  anything between presses); an empty or already-fully-selected bullet skips rung 1. There is
  **deliberately no per-level climb** — `Cmd+A` is the big-jump scope tool, `Shift+arrow` is the
  surgical sibling tool, and overlapping them (both doing sibling-level work) was the rejected
  design.
- **While selected:** plain `↑/↓` drops the caret onto the visible row just *above the top* / *below
  the bottom* of the selection (the existing visual neighbor walk — caret motion is visual even
  though selection is sibling-scoped). A printable `[a-zA-Z]` key is a **no-op; the selection
  persists** — it must **never** replace-on-type the way a text editor does, or a stray keypress
  would delete whole subtrees. `Escape` clears → caret returns; a click clears → normal edit.

**Operations (this ADR's v1):** **Copy as Markdown** (`Cmd+C`, reuses the ADR 0029 serializer over
the selected roots) and **Delete** (`Backspace`/`Delete`, loops `removeNode` over the selected roots
inside one `runStructural` batch). **Deferred:** Tab indent/outdent, drag, cut, paste — paste needs
a node-clipboard format and insertion logic that doesn't exist, and drag is a single-node imperative
system (`use-drag-reorder.ts`) that needs real surgery to carry a selection. Copy + delete is the
coherent minimal set (shipping copy without delete would confuse — the most-expected key is
Backspace).

**The actions menu, and `runMany`.** When a selection exists, a menu **auto-appears anchored to the
selection's top row**, reusing `SlashMenuList`'s rendering (no second menu look); `Escape` dismisses
and clears. It lists core **Copy** + **Delete** plus every plugin command that opts in. A single-node
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

**Don't:** use a visual-flatten selection; loop `run(nodeId)` over a set; let typing replace a
selection; thread selection through props; or route the batch delete outside `runStructural`.
