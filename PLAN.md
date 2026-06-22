# PLAN: Scale dotflowy + ship multi-device sync

Working plan for taking dotflowy from "fast at hundreds of nodes" to "fast at tens of
thousands, synced across a user's devices." Decision record lives in
[ADR 0015](./docs/adr/0015-scaling-roadmap-o1-write-path.md); the sync design will land in
**ADR 0016** (not yet written). This file is the execution plan + the open decisions.

**Status (2026-06-22):** diagnosis done, roadmap sequenced, sync direction decided.
**Blocked on:** 6 design decisions (see "Open decisions") before ADR 0016 can be written.
**Next action:** Cam answers the open decisions → write ADR 0016 → start item 2 (fractional index).

---

## North star: the O(1) write-path invariant

> A keystroke (or structural edit) should do work bounded by the **viewport**, not the **document**:
> O(1) storage write, O(1) index update, O(1) undo capture, O(viewport) DOM.

[ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md) made *rendering* O(1).
The rest of the write path is still O(total nodes). This plan finishes the job, on a data model
that also supports sync.

---

## Diagnosis: why it won't scale today

Ranked by which wall hits first as the document grows:

| # | Bottleneck | Where | Bites as |
|---|---|---|---|
| 1 | Whole document re-serialized + written to localStorage on every edit (sync, main-thread); **hard ~5MB quota** | `collection.ts` (`localStorageCollectionOptions`) | jank, then a hard `QuotaExceededError` wall |
| 2 | **Whole document mounted in the DOM** — `collapsed` is CSS-only, children stay mounted | `OutlineNode.tsx`, `useVisibleChildIds` (filters `completed`, not `collapsed`) | load + scroll cost ∝ total nodes |
| 3 | Tree index **rebuilt from scratch** on every mutation + notify-storm with `join('\n')` keys | `tree-store.ts` `rebuild()` → `buildTreeIndex(toArray)` | per-keystroke CPU |
| 4 | Undo **deep-copies all nodes** per action, ×100 entries | `history.ts` `snapshot()` | O(100 × n) memory |
| 5 | `prevSiblingId` linked-list ordering: relinks 2–3 rows/move, forces cycle-guard + orphan-recovery; worst primitive for sync | `mutations.ts`, `tree.ts` | fragility now; sync conflicts later |

The flat-list model is **right** (maps to rows, cheap moves). The problem is re-materializing the
whole document at three layers and mounting it at a fourth — not the storage shape.

---

## Decisions (locked)

- **Sync is near-term**, and it's **single user across their own devices** — not multi-user collaboration.
- **Conflict model: last-write-wins per row**, keyed on the existing `updatedAt`. **No CRDT.**
- **Backend stays in SQLite — not Postgres.** Lead: **Turso / libSQL** (SQLite-native, local-first,
  database-per-tenant is its headline feature). Fallback: **Cloudflare Durable Object (SQLite) per
  user**. D1 is a distant third (built for fewer, larger DBs, not one-per-user).
- **Future:** each tenant gets their own database (Turso supports natively).
- **Browser feasibility confirmed:** Turso runs SQLite as **WASM + OPFS persistence** with offline
  push/pull sync in-browser (2026). Caveats live in "Risks."

---

## Open decisions — gate ADR 0016 (Cam to answer)

> These are the genuine judgment calls. Recommendation given for each; react or override.

### Tier 1 — showstopper-class
- [ ] **D1. Cross-origin isolation.** OPFS + SharedArrayBuffer needs COOP/COEP headers, which can
      break third-party embeds/scripts. *Rec:* confirm the deploy tolerates COOP/COEP and no
      third-party script breaks; else use the non-SAB OPFS path (slower) or wa-sqlite + custom sync.
- [ ] **D2. Auth is a hidden prerequisite.** Per-tenant DB + sync needs accounts + scoped tokens; the
      app is anonymous-localStorage today. *Rec:* keep anonymous local-first mode (no account to
      edit); signup provisions the Turso DB and pushes the existing local doc up. Don't gate the
      editor behind login.

### Tier 2 — correctness forks
- [ ] **D3. LWW on a tree creates cycles.** `parentId`/`sortKey` are relational; per-row LWW can merge
      two valid trees into a cycle/orphan. *Rec:* per-row LWW + a deterministic **repair pass on
      load** — promote `buildTreeIndex`'s existing cycle-guard/orphan-recovery from defensive guard to
      documented merge-repair. Accept rare loss; skip a full tree-CRDT for v1. **(The sharp one.)**
- [ ] **D4. "Per-field" LWW is really per-row** (one `updatedAt`/node). Concurrent `collapsed` (device
      A) + `text` (device B) on the same node → later write clobbers both. *Rec:* accept per-row for
      v1; per-field timestamps only if it bites.
- [ ] **D5. Deletes resurrect under LWW** (an update re-creates a deleted row — the undo code already
      does this). Subtree-delete vs concurrent insert = orphan. *Rec:* **tombstones** (soft `deletedAt`
      + GC after a sync-safe window).
- [ ] **D6. Fractional-index collisions.** Two offline inserts between the same siblings pick the same
      key. *Rec:* fractional-indexing with a **per-client jitter/id** tiebreaker; no key rebalancing in
      v1 (accept growth on repeated same-spot insert).

### Tier 3 — confirmations (baked into the ADR 0016 draft unless overridden)
- [ ] **D7. Composition:** custom TanStack DB `SyncConfig` adapter reads/writes the local WASM-SQLite
      DB; Turso engine handles libSQL↔cloud; `OfflineExecutor` owns the outbox so beta wobble ≠ data loss.
- [ ] **D8. Migration:** `dotflowy-oss:nodes` localStorage → local SQLite → provision Turso DB → first
      push; folded with the `prevSiblingId → sortKey` backfill. One-time, idempotent.
- [ ] **D9. Undo under sync:** local inverse-patch that propagates as ordinary edits; never a global
      snapshot restore.

---

## Execution plan (foundation-first)

Sequenced so the data model + sync layer land before more is built on the throwaway `prevSiblingId`.
Tracked as session tasks #1–#7.

- [x] **0. Decide sync horizon** — done: near-term, single-user-multi-device. *(task #1)*
- [ ] **1. Design the sync architecture → ADR 0016** — blocked on the open decisions above. LWW +
      Turso adapter shape, local-as-working-copy, migration, beta de-risking. *(task #7)*
- [ ] **2. Fractional index ordering** — replace `prevSiblingId` with a sortable `sortKey`; move =
      rewrite one row; delete cycle-guard/orphan-recovery once merge-repair (D3) replaces it. Schema
      change + backfill migration. *Blocks on:* ADR 0016. *(task #6)*
- [ ] **3. Sync adapter + local persistence** — custom libSQL/Turso `SyncConfig`; the synced local
      SQLite *is* the durable store (subsumes the old localStorage→IndexedDB swap). Multi-tab
      coordination; offline reconcile. *Blocks on:* ADR 0016, item 2. *(task #2)*
- [ ] **4. Incremental index** — apply local + inbound-remote deltas to the existing index instead of
      full rebuild (or drive from live-query IVM). *Blocks on:* ADR 0016. *(task #4)*
- [ ] **5. Inverse-patch undo** — revert only this client's change; correctness item under sync.
      *Blocks on:* item 3. *(task #5)*
- [ ] **⊥. Virtualize the visible list** — window to viewport; stop mounting collapsed subtrees.
      Orthogonal to sync; schedule anytime **except** mid-migration. Hard part: coexist with
      contentEditable / refs registry / caret-column nav / zoom-pivot morph (keep pivot + focused row
      mounted). *(task #3)*

### Acceptance (the invariant, made testable)
- Typing latency + write time **flat from 1k → 50k nodes**; no `QuotaExceededError`.
- Edits propagate device→device; offline edits reconcile on reconnect.
- Mounted DOM node count **bounded by viewport**, independent of doc size.
- Per-keystroke and per-remote-delta index work **O(changed), not O(n)**.
- Undo never clobbers a synced-in remote edit; stack memory O(edits), not O(n × 100).
- A move rewrites **exactly one row**; tree survives concurrent edits (repair pass holds).
- ADR 0014 hand-verification set still passes (caret nav, zoom morph, focus-after-mutation, drag).

---

## Risks / unknowns to verify in ADR 0016

- **Turso Offline Sync is public beta** (2026-06). De-risk: TanStack DB `OfflineExecutor` owns the
  outbox/retry; Turso is transport. Fallback: wa-sqlite (OPFS) + custom sync to Turso Cloud, or the
  DO-per-user route.
- **Web SQLite persistence has caveats** (OPFS worker setup, SharedArrayBuffer needs cross-origin
  isolation, JSPI maturing through 2026). See D1.
- **No first-party Turso ↔ TanStack DB adapter found** — item 3 writes a custom `SyncConfig`;
  re-check for a community adapter first.
- **Auth/identity does not exist yet** (D2) — a real prerequisite, not part of the editor work.

---

## Pointers

- Decision record: [ADR 0015](./docs/adr/0015-scaling-roadmap-o1-write-path.md) · sync design: ADR 0016 (TODO)
- Prior art this builds on: [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md) (pull-model rendering)
- Tasks: #1 (done) · #2–#7 (the items above)
- Validation gate: `bun run typecheck` (no test runner — `AGENTS.md`), plus a large-document fixture
  and a two-client sync fixture to be added.
