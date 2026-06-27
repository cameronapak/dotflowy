# Atomic structural writes

**The invariant.** Within any parent, the `prevSiblingId` chain must be total and acyclic: exactly
one head (`prevSiblingId === null`), every other child points at a present sibling, and following
the chain reaches every child once. `buildTreeIndex` rebuilds sibling *order* from this chain at read
time, so a broken chain (a **fan** — two siblings sharing one prev; a **dangle** — a pointer to a
deleted/foreign id) silently orphans nodes: they render but can't be reordered, and it survives
refresh because the bad pointers are persisted. (Real bug: Jam `4b88ccae`.)

**The tear it fixes.** Maintaining the invariant on an insert/delete needs ≥2 nodes touched together
(insert a node **and** repoint its follower; delete a node **and** repoint its follower). The naive
path tears that apart: TanStack DB routes inserts → `onInsert` → POST and updates → `onUpdate` →
PATCH — two requests, two DO `commitChange`s, two `seq`s, two broadcast frames. A dropped half, or a
fast follow-up edit computed against the half-applied state, persists a fan/dangle. (Update-only ops
— moves, indent/outdent — were always one PATCH = one frame, which is why *reordering* never
corrupted; the damage clustered in create/delete-heavy areas.)

**The cure — `runStructural` (`structural.ts`), two properties, both required:**
- **P1 (atomic):** wrap every tree-shape edit so all its `nodesCollection.insert/update/delete`
  calls join ONE `createTransaction`, whose `mutationFn` ships them as a single `persistBatch` →
  POST `/api/nodes {ops}` → the DO's `applyBatch` → one `commitChange` → one frame. All-or-nothing.
- **P2 (hold-until-echo):** the transaction's `mutationFn` awaits `waitForSeq(seq)` — it does not
  resolve until the batch's own change frame echoes back. This is **load-bearing, not belt-and-
  suspenders:** a `createTransaction` op (unlike a direct `collection.update`, which TanStack DB
  marks a *direct* transaction and retains after completion) has its optimistic overlay **dropped on
  completion unless its echo has already landed** (`recomputeOptimisticState`, `state.js`). Without
  the wait the view would briefly revert to pre-op, and a fast follow-up edit would re-create a fan.
- **P3 (serialize on the wire):** `persistBatch` (`api.ts`) chains every batch POST off the previous
  one's response (`batchTail`) so the DO receives rapid batches in client-call order. P1/P2 keep the
  *local* state consistent, but two quick edits open independent transactions whose `mutationFn`s
  fire **concurrent** fetches — and separate requests have no ordering guarantee (HTTP/2 muxing). The
  DO stamps each frame's `seq` in arrival order, so a later batch landing first would let its repoint
  of a shared follower be overwritten by the earlier batch's stale one — a persisted fan, the exact
  bug, despite atomic frames. Serializing makes logical order == persisted order; the overlay is
  already on screen so the added round-trip is invisible.

**The structural-vs-field split is deliberate.** Only tree-shape ops route through `runStructural`
(insert/indent/outdent/move/reparent/remove, history undo/redo restore, the daily get-or-create).
**Field edits stay direct** (`setText` per keystroke, `toggleCompleted/Collapsed`, `setIsTask`,
`toggleBookmark`): each is a single-node, single-field PATCH = already one frame, and the
per-keystroke text path **must not** await an echo. (Direct ≠ unguarded: field PATCHes are still
serialized + coalesced on the wire and the focused bullet ignores echo-driven repaints — see [ADR 0010:
Field edits — serialize, coalesce, ignore echoes on the caret](./0010-field-edits-serialize-coalesce-ignore-echoes.md).)
`runStructural` self-guards nesting (`getActiveTransaction`) so a compound flow that calls it twice
still emits one frame.

**Defense in depth, kept:** `healSiblingChains` (`collection.ts`) still repairs any persisted
corruption on snapshot load (pre-fix data still exists in users' DOs; cheap and idempotent), and a
DEV-only invariant tripwire in `runStructural` `console.error`s if an op ever leaves a touched
parent's chain broken.

**Don't:** route field edits through `runStructural` (per-keystroke echo-await = janky typing);
remove the `waitForSeq` ("the POST already returned 200") — that reintroduces the revert window;
unserialize `persistBatch` ("each batch is atomic, so order doesn't matter") — concurrent batches
can reach the DO out of order and persist a fan (P3); split a structural op's writes back into
per-type handler calls (the original tear); or drop `healSiblingChains` until the tripwire has been
silent in prod for weeks.
