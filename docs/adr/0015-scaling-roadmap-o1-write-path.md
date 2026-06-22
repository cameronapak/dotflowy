# ADR 0015: Scaling roadmap — an O(1) write path

Status: accepted (2026-06-22), **not yet implemented**. This ADR records the
diagnosis, the target invariant, and the sequencing. Each phase lands its own
implementation ADR (0016+) as it ships, or updates this one's checklist.

**Gate resolved (2026-06-22): sync is near-term.** The plan is therefore
**foundation-first** (build the conflict-safe data model + sync/persistence layer
before more lands on the throwaway `prevSiblingId` ordering). Near-term sync also
changes the *nature* of two items, not just their order (see Decision). The
sync-architecture design itself becomes **ADR 0016**.

**Conflict model + backend resolved (2026-06-22).** Sync is **single user across their
own devices**, not multi-user collaboration → **last-write-wins per field** (we already
carry `updatedAt` on every node) + fractional index for order. **No CRDT.** Backend stays
in **SQLite** (no Postgres): **Turso / libSQL** is the lead candidate — SQLite-native,
local-first, and database-per-tenant is its headline capability (matches the future
"each tenant gets their own database" goal). Turso **Offline Sync** (public beta as of
2026-06) provides local-SQLite offline writes that push/pull to Turso Cloud. Details +
the de-risking (TanStack DB offline outbox so we don't hard-depend on a beta) land in ADR 0016.

## Glossary

- **Write path** — everything a single keystroke or structural edit triggers between the keypress
  and the settled UI: storage persistence, tree-index derivation, undo capture, and DOM.
- **O(1) write-path invariant** (target) — a keystroke should do work bounded by the *viewport*, not
  the *document*. Concretely: O(1) storage write, O(1) index update, O(1) undo capture, O(viewport)
  DOM. Today three of those four are O(total nodes). See [ADR 0014](./0014-localized-node-rendering-via-tree-store.md),
  which made *rendering* O(1) but left the rest O(n).
- **Fractional index** — a sortable per-row order key (a string or float). Order = sort siblings by
  key; insert between two siblings = pick a key between theirs; move = rewrite **one** row. Replaces
  the `prevSiblingId` linked list. The ordering scheme infinite-outliners and CRDT-backed editors
  converge on.
- **Conflict model** — the rule for resolving two devices editing concurrently. **Settled: LWW**
  (last-write-wins per field, keyed on `updatedAt`) — sync is single-user-multi-device, so CRDT/OT is
  unnecessary. A per-tenant database means the only concurrency is one user's own devices, rarely
  simultaneous, which makes LWW safe.

## Context: ADR 0014 fixed one of four O(n) layers

ADR 0014 made a keystroke re-render only the edited bullet. But the rest of the write path still
scales with **total document size**. At the documented "hundreds to low thousands" of nodes this is
invisible; as the outline grows it is the wall every big-outline app eventually hits. The four
layers, ranked by which one bites first:

1. **localStorage serializes the whole document on every edit.** `collection.ts` uses
   `localStorageCollectionOptions`. localStorage has no partial-write API, so the entire collection
   is `JSON.stringify`'d and written **synchronously on the main thread** per change. Two ceilings: a
   per-keystroke stringify+write that grows with doc size (jank), and a **hard ~5MB origin quota**
   that *throws* rather than slows (a wall, not a slope).
2. **The whole document is mounted in the DOM.** `useVisibleChildIds` filters by `completed`, **not
   by `collapsed`** (`tree-store.ts`); `OutlineNode` renders all children of a collapsed node and the
   wrapper clamps height to 0 in CSS so the reveal can animate (`OutlineNode.tsx`). So mounted DOM ≈
   every node in the document. Each bullet carries a contentEditable, a `useHotkeys` registration
   set, and a slash-menu hook. Collapsing unmounts nothing.
3. **The tree index is rebuilt from scratch on every mutation.** `tree-store.ts` `rebuild()` runs
   `buildTreeIndex(nodesCollection.toArray)` on every change — a fresh O(n) array allocation, full
   `byId` rebuild, and a `prevSiblingId` walk per parent — then notifies every mounted listener, each
   of whose `useVisibleChildIds.getSnapshot` rebuilds its child-id list and a `join('\n')` key just
   to discover nothing changed. `tree.ts` foreshadows this: *"if it ever gets slow, memoize per-parent."*
4. **Undo deep-copies all nodes per action.** `history.ts` `snapshot()` copies every node, per
   captured action, up to `MAX_ENTRIES = 100`. O(100 × n) memory. Text runs coalesce; every
   structural action snapshots the whole doc.

A fifth item is not a local perf wall but a **fragility and sync tax**: `prevSiblingId` ordering
relinks 2–3 rows per move and forces `buildTreeIndex`'s cycle guard + orphan-recovery. It is also the
worst ordering primitive for the sync backend — concurrent inserts after the same sibling conflict.
With sync near-term, this moves to the front of the plan.

## Decision

Drive the write path to the **O(1) write-path invariant**, **foundation-first** now that sync is
near-term: build the conflict-safe data model and the sync/persistence layer before piling more on
the throwaway `prevSiblingId` ordering, then layer the sync-aware perf items on top.

| Order | Item | Why this slot | Effort |
|---|---|---|---|
| 1 | **Design the sync architecture** — backend + conflict model (→ ADR 0016) | Everything below depends on it; it picks the storage medium and the ordering/conflict rules | — |
| 2 | **Fractional index ordering** (replace `prevSiblingId`) | Relinks 2–3 rows per move and conflicts badly under concurrent edits; build the conflict-safe primitive *before* more lands on it | High |
| 3 | **Sync adapter + local persistence** (custom libSQL/Turso `SyncConfig` adapter) — *subsumes* the old localStorage→IndexedDB swap | The synced local SQLite *is* the durable store; a stopgap IndexedDB-only adapter would be thrown away when sync lands | Med |
| 4 | **Incremental index** from change deltas | Now also consumes the inbound *sync* delta stream, not just local edits — promoted from hygiene to load-bearing | Med |
| 5 | **Inverse-patch undo** | Under sync this is a **correctness** item, not memory hygiene: a full-snapshot restore stomps concurrently-synced remote edits | Med |
| ⊥ | **Virtualize the visible list; stop mounting collapsed subtrees** | Orthogonal to sync; the biggest perceived-perf win. Schedule anytime *except* mid-migration (risk stacks) | Med |

**Why foundation-first.** Near-term sync turns three of the original "later" items load-bearing. The
ordering primitive (`prevSiblingId`) is unsafe under concurrent edits, so fractional indexing moves
to the front — and every mutation in `mutations.ts` built on relinking is throwaway until it lands,
so we do it *before* adding more. The storage decision is no longer a local-only swap: the sync
adapter brings its own durable local persistence, so the old "Phase 1" IndexedDB swap is *subsumed*
rather than done-then-replaced.

**Why two items change nature under sync.**
- *Incremental index*: a full rebuild per change was merely slow locally; under sync, remote edits
  arrive as a delta stream that a from-scratch rebuild handles badly, so incrementality becomes the
  natural design, not an optimization.
- *Undo*: `history.ts`'s full-state snapshot restore is outright **incorrect** under sync — restoring
  "all nodes as they were" would clobber edits that synced in from another device between capture and
  undo. Inverse patches that revert only *this* client's change are required for sync-correct undo.

**Virtualization is orthogonal.** It touches rendering, not the data model or sync, so it can ship at
any point. It is sequenced last only to avoid stacking its contentEditable / caret-nav / zoom-morph
risk on top of an in-flight data-model migration — not because it depends on the rest.

### Acceptance criteria (the invariant, made testable)

- **Sync design (ADR 0016)**: conflict model chosen (LWW vs CRDT) with the single-user-vs-multi-user
  rationale; backend chosen; the local collection's role (source of truth vs cache) defined.
- **Fractional index**: a move rewrites exactly one row; `buildTreeIndex`'s cycle guard +
  orphan-recovery can be deleted; ordering survives concurrent inserts after the same sibling. Schema
  adds `sortKey`, retires `prevSiblingId`, with a localStorage backfill migration.
- **Sync adapter**: edits propagate device→device within the backend's latency budget; offline edits
  reconcile on reconnect; no `QuotaExceededError`; typing latency flat from 1k → 50k nodes.
- **Incremental index**: per-keystroke *and* per-remote-delta index work is O(changed), not O(n);
  whole-index readers (switcher, bookmarks) still correct.
- **Inverse-patch undo**: undo reverts only this client's change and never clobbers a synced-in remote
  edit; stack memory O(edits since cap), not O(n × 100).
- **Virtualization**: mounted DOM node count bounded by viewport, independent of document size; the
  ADR 0014 hand-verification set (caret nav, zoom morph, focus-after-mutation, drag) still passes.

## Why

- **The flat model is right; the derivations around it aren't.** Flat rows keyed by id map cleanly
  onto a sync backend and keep moves cheap (`schema.ts`'s rationale holds). The bottleneck is that we
  *re-materialize the whole document* at three layers (storage, index, undo) and *mount the whole
  document* at a fourth — not the storage shape.
- **Most fixes are inside the stack already chosen.** TanStack DB exposes the custom-adapter path
  (`SyncConfig` / `ChangeMessage` / `loadSubset`), an offline outbox (`OfflineExecutor`), and delta
  subscriptions (`subscribeChanges` / live-query IVM) the plan leans on. The component layer stays
  put; this is a custom sync adapter + a data-model change, not a framework rewrite. (Note: the
  Postgres-oriented `electricCollectionOptions` / `powerSyncCollectionOptions` do *not* fit the
  SQLite-server constraint, so item 3 is a custom Turso adapter, not a drop-in.)
- **Foundation-first protects against a double migration.** Doing fractional indexing and the sync
  adapter before virtualization and more feature work means we change the data model once. Building
  more on `prevSiblingId` now would be throwaway.

### What this does NOT change

- **The flat-list storage shape.** Rows stay flat, keyed by id. Fractional indexing swaps the
  *ordering field* (`prevSiblingId` → `sortKey`); it does not nest the tree.
- **ADR 0014's pull-model rendering.** `useNode` / `useVisibleChildIds` stay; the incremental-index
  item changes how the index behind them is *maintained*, virtualization changes *which*
  `OutlineNode`s mount — neither changes the subscription contract.

## Rejected / deferred alternatives

- **Nested-tree storage** (store children inline) — rejected. Loses O(1) moves, forces a deep tree
  merge on every keystroke, and is hostile to row-based sync. The flat list is the correct base.
- **Keep `prevSiblingId`, resolve order conflicts at sync time** — rejected. Linked-list ordering has
  no clean concurrent-insert resolution; fractional indexing makes order a per-row scalar that merges
  trivially. This is the whole reason fractional indexing leads the plan.
- **Stopgap local IndexedDB adapter now, sync later** — rejected under near-term sync. The sync
  adapter supplies durable local persistence; an interim local-only adapter is throwaway work.
- **Keep full-snapshot undo** — rejected under sync (incorrect: clobbers synced-in remote edits).
- **CRDT text by default** — rejected. Sync is single-user-multi-device, so LWW per field (on
  `updatedAt`) avoids CRDT entirely. Revisit only if multi-user collaboration is ever added.
- **Postgres-backed sync (Electric / PowerSync)** — rejected. The backend stays in SQLite (Turso /
  libSQL) per the per-tenant + SQLite-native goal; these adapters target Postgres.
- **Move index derivation / persistence to a Web Worker** — deferred. Reconsider only if profiling
  after the incremental index + sync adapter still shows main-thread stalls.

## Known rough edges / open questions

- **Turso Offline Sync is public beta (verify in ADR 0016).** It provides the local-SQLite offline
  writes the design needs, but it's beta. De-risk by letting TanStack DB's `OfflineExecutor` own the
  outbox/retry so correctness doesn't hard-depend on the beta; treat Turso sync as the transport.
  Fallback if Turso's offline path disappoints: one Cloudflare **Durable Object (SQLite) per user** —
  a DO *is* an isolated per-tenant SQLite DB, the same database-per-tenant shape, with a WebSocket
  sync protocol we own. (Cloudflare **D1** is the weakest of the three for per-tenant-at-scale — it's
  designed around fewer, larger databases, not one-per-user — so it's a distant third.)
- **No first-party Turso ↔ TanStack DB adapter found.** Item 3 writes a custom `SyncConfig` adapter
  (the documented path); re-check for a community adapter before building.
- **Virtualization × contentEditable.** The zoom-pivot element must stay mounted for the morph, the
  `refs` registry assumes mounted spans for focus movement, and caret-column nav reads laid-out rects.
  Likely shape: keep the pivot + focused row always mounted, window the rest. Its own design pass.
- **No test runner** (`AGENTS.md`). Each item is verified by `bun run typecheck` + the ADR 0014
  hand-verification set, extended with a large-document fixture (generate N nodes; measure typing
  latency and DOM count) and a two-client sync fixture.
