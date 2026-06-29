---
status: proposed
---

# Virtualized outline rendering

**What.** Invert the editor's render model from a **recursive DOM tree** to a **flat, windowed list**.
Today every visible (non-collapsed, non-pruned) node is a mounted contentEditable subtree
(`OutlineNode` → `OutlineNodeChildren` recursing), so DOM weight grows with total visible nodes — the
felt scaling wall (scroll jank, heavy paint, slow zoom-out), distinct from the re-render *fan-out*
that [ADR 0014](./0004-localized-rendering-via-the-tree-store.md) already solved. We flatten the
visible tree into one linear `{id, depth}[]` list and render only the on-screen slice via
`@tanstack/react-virtual`; nesting becomes visual indentation by `depth`, not DOM structure. Render
cost becomes ∝ viewport, not total nodes. Target: 100k-node outlines that scroll and type smoothly.
Designed here; build plan + staging in `.scratch/scale-outline/PRD.md`. Ships **behind a flag**, the
recursive path kept until e2e parity, then flipped and the old path deleted.

**Why a flat list, not a virtualized tree.** A windowed *tree* (virtualize each parent's children
independently) keeps the recursion and can't window across deep nesting — a single root with a long
descendant chain is still one giant mounted subtree. Flattening collapses the whole visible outline
to one linear sequence, so windowing is uniform regardless of nesting depth or where collapse
boundaries fall. It's the model Workflowy/Roam use, and the flatten already exists for caret nav
(`flattenVisible`, `visible-order.ts`) — Phase B promotes it to `{id, depth}[]` and makes it the
render driver, one definition shared by rendering and the neighbor walk.

**Depends on the incremental index (Phase A).** The flatten reads the tree index on every structural
change; on the current full-rebuild index that's an O(n) walk per change. Phase A (incremental index,
id-array `childrenByParent`, dirty-parent re-sort — code-commented, no ADR) makes structural changes
O(changed) and text edits O(1), so the flatten driver is cheap. A precedes B.

**Edge cases — all reuse existing machinery, no new subsystems:**
- **Focus across the window edge.** Off-screen rows aren't mounted, so the `refs` map has no span.
  Focusing a node not in the window does `virtualizer.scrollToIndex(i)` first; the existing
  `pendingFocus` claims the span when the row mounts. No new focus model.
- **Zoom view-transition morph.** The pivot is the zoom root, which `flattenVisible` always pushes as
  row 0 — always mounted/near top — and the click source is mounted by definition, so both morph
  endpoints exist. Verify by instrumenting `startViewTransition` (screenshots can't see a morph).
- **Drag-reorder.** `use-drag-reorder.ts` hit-tests against the flat-list index (y→gap, x→depth), not
  mounted DOM, and auto-scrolls at the viewport edge (the `scrollIntoView({block:"nearest"})` pattern
  multi-select already uses) so an off-screen drop target comes into range.
- **Flash / reject one-shot classes.** A row that scrolls into view reads its own `pendingFlash` at
  mount, so a flash queued for an off-screen row (e.g. `/move`'s post-nav flash) still fires.
- **Variable row height.** Bullets wrap, so rows are dynamically measured (`measureElement`), not
  fixed-height.

**Scope boundary — interaction, not cold-load.** Phase B (with A) makes *interaction* — typing,
scrolling, zoom — smooth at 100k. It does **not** shrink the initial payload: the DO still streams a
full snapshot on connect (~20MB at 100k nodes). Bounding cold-load/memory is **Phase C** (lazy
subtree sync — TanStack DB on-demand `syncMode`/`loadSubset` + a DO that serves subtree queries), a
separate decision recorded when load-time (not interaction) is the complaint. A+B deliberately do not
attempt it.

**Don't regress:**
- Keep the per-node subscription model (`useNode`/`useVisibleChildIds`/`useSelectionEdge`) — the row
  still reads its own slice; windowing changes *how many* rows mount, not how a row gets its data.
  Don't thread `node`/`index`/selection as props ([ADR 0014](./0004-localized-rendering-via-the-tree-store.md)).
- One flatten definition (`visible-order.ts`) drives both render and caret nav — don't fork a
  render-only copy that can drift from the neighbor walk.
- Delete the recursive path once the flag flips; don't leave two render models alive.
