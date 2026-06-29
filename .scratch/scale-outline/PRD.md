# PRD: Scale the outline to 100k nodes

Status: Phase A built + green (serial e2e 83/83, unit 117/117, typecheck/lint clean). Phase B next.
ADR 0019 (virtualization) proposed. Decision record:
[ADR 0019](../../docs/adr/0019-virtualized-outline-rendering.md).

## Why

Dotflowy slows as nodes accrue. The felt symptom is **render/DOM weight** (scroll jank, heavy paint,
slow zoom-out), not typing latency — confirmed with Cam.
[ADR 0014](../../docs/adr/0004-localized-rendering-via-the-tree-store.md) already killed the
re-render *fan-out* (per-node subscriptions), but every visible node is still a mounted
contentEditable subtree, and the tree index still fully rebuilds on every change. Two O(n) costs
remain in the hot path:

1. **Render** — DOM grows with total visible nodes (no windowing): `OutlineNode` →
   `OutlineNodeChildren` recurses every visible node. *This is what hurts first.*
2. **Index** — `tree-store.ts rebuild()` runs `buildTreeIndex(toArray)` on every `subscribeChanges`;
   O(n) per committed edit + its echo.

Target ceiling: **100k nodes**, smooth scroll + typing.

## Locked design (from the grill)

- **Target = 100k interaction-smooth.** Cold-load is explicitly out of scope (Phase C).
- **Build order: A (incremental index) → B (virtualization).** Both required at 100k; A is the
  low-risk foundation that makes B's flatten cheap. No standalone "ship A for its own sake" — at
  ≤10k it wouldn't be worth it; we're building for 100k.
- **Phase A is not premature.** At 100k the O(n) rebuild is tens of ms/keystroke even after B, so A
  is mandatory, not polish. (Owned reversal of the earlier "don't ship standalone A" — that held
  only for a ≤10k world.)
- **TreeIndex shape: id-arrays.** `childrenByParent: Map<string, string[]>`; node lookups always
  through `byId` (one source of truth). Text edits never touch sibling arrays → O(1). It's also the
  shape B's flatten wants. `childrenOf` keeps its `Node[]` signature (maps ids→byId on read).
- **B inverts to a flat windowed list** (`@tanstack/react-virtual`); ADR 0019 owns the edge-case
  handling (focus, zoom morph, drag, flash, measurement). Behind a flag until e2e parity.
- **Phase C (lazy subtree sync) parked** until cold-load is the complaint.

## Scope

**Phase A — incremental tree index** (this ship):
- `tree-store.ts`: consume the `ChangeMessage[]` from `subscribeChanges` (currently ignored), patch
  the index in place; dirty-parent set; re-sort only dirtied parents. Snapshot/truncate keeps the
  full rebuild as the safe fallback.
- `tree.ts`: `childrenByParent` → `Map<string, string[]>`; `childrenOf` maps ids→byId; ordering reads
  prev pointers from byId.
- Load-bearing code comment (the dirty-set + why an agent shouldn't "simplify" it to a full rebuild).
- No behavior change → existing e2e covers it; add a large-outline typing-latency check.

**Phase B — virtualized rendering** (ADR 0019):
- Promote `flattenVisible` → exported `{id, depth}[]`, identity-stable subscribed slice.
- `OutlineEditor`: `useVirtualizer` over the flat list + `measureElement`.
- `OutlineNode`: split a flat row (body only, indent by depth, drop `OutlineNodeChildren`).
- Focus-into-window (`scrollToIndex` + `pendingFocus`); drag auto-scroll; flash-on-mount.
- Flag + new windowing/perf e2e (seed 10k, assert DOM row count ∝ viewport); flip + delete recursive
  path.

**Phase C — lazy subtree sync** (deferred, own ADR):
- TanStack DB on-demand `syncMode`/`loadSubset`; DO serves subtree snapshots + per-subtree change
  subscriptions. Only when load-time (not interaction) is the complaint.

## Phase A build checklist

- [x] `tree.ts`: `TreeIndex.childrenByParent: Map<string, string[]>`; `childrenOf` maps ids→byId;
      `orderChildIds` helper reads prev pointers from byId.
- [x] `sibling-chain.ts`: unchanged — `orderSiblings(Node[])` stays the canonical orderer;
      `orderChildIds` (tree.ts) wraps it for the id path. `chainDisagreements` untouched.
- [x] `tree-store.ts`: incremental `applyChanges(changes)` — byId patch + dirty-parent re-sort.
      Snapshot/truncate needs no special-case (truncate emits per-row deletes — verified in DB
      source — so the delta path rebuilds it correctly).
- [x] Audit every `childrenOf` caller — all read nodes through byId; only `collection.ts`
      `siblingChainRepairs` touched `childrenByParent` directly (fixed to map ids→byId).
- [x] Code comment documenting the dirty-set + the identity discipline (fresh Maps on structural,
      same refs on field edits). No stale notes left in AGENTS.md/README.
- [x] typecheck + typecheck:test + lint + unit green; **e2e 83/83 serial** (parallel daily flake is
      pre-existing — confirmed 5/16 on clean HEAD).
- [ ] **Remaining:** large-outline (10k+) typing-latency perf spec — folds into Phase B's perf gate
      (seed 10k, assert DOM rows ∝ viewport + keystroke latency flat). Deferred to B.

## Gotchas learned (Phase A)

- **In-place Map mutation breaks reference-identity memoization.** The old `buildTreeIndex` made a
  fresh `byId` Map every change, so consumers/React-Compiler memos keyed on `index.byId` invalidated
  for free. Mutating in place froze that ref → the Cmd+K switcher's node list went stale (a
  just-created node never appeared in search; e2e `daily-notes :401`). Fix: fresh Maps on structural
  changes only; field edits keep refs (the O(1) hot path) because per-node reactivity rides `useNode`
  (node-object identity) and whole-tree readers (`useViewFilter`) key on the wrapper, not the Maps.
- **Re-sort every parent touched by a structural change**, not just inserts. A multi-write op is
  transiently inconsistent mid-batch (a delete repoints the follower's prev *then* deletes → a brief
  "fan"); only re-deriving from the settled `byId` fixes it — exactly what the old full rebuild did.
