# PLAN: Atomic structural writes (kill the node-corruption class)

> **Status:** IMPLEMENTED on branch `feat/atomic-structural-writes` (P1 server +
> P2 client + tripwire + tests; typecheck/typecheck:worker/lint green, structural
> e2e green). The decision now lives in
> [`docs/DECISIONS.md` § Atomic structural writes](./docs/DECISIONS.md#atomic-structural-writes)
> — delete this working doc once the branch merges. Not a permanent record.
>
> **Owner:** Cam. **Origin:** the "some bullets won't reorder, even after refresh"
> bug (Jam `4b88ccae`), root-caused this session.

---

## TL;DR

Structural edits (insert / delete a bullet) are **not atomic** at the
persistence boundary: one logical edit becomes 2+ HTTP requests → 2+ Durable
Object writes → 2+ broadcast frames. Any gap between them persists a broken
`prevSiblingId` chain (a "fan" or a "dangle"), which makes nodes unmovable. The
shipped `healSiblingChains` is a **safety net for the symptom**; this plan is the
**cure**: make every tree-shape mutation a single atomic write, plus hold the
optimistic overlay until its echo lands so a fast follow-up edit can never read a
half-applied state.

**Effect TS: not for this.** See [§ Why not Effect TS](#why-not-effect-ts). The
fix lives at the network/DO boundary; Effect operates a layer above it and would
be a large migration aimed at the wrong target. This is plain TanStack DB +
promises + our existing `errore` convention.

---

## The invariant we must guarantee

> Within any parent, the `prevSiblingId` linked list is **total and acyclic**:
> exactly one child has `prevSiblingId === null` (the head), every other child's
> `prevSiblingId` is a present sibling, and following the chain reaches every
> child exactly once.

Today this invariant is maintained *per logical mutation* in `mutations.ts`, but
it is **not preserved across the persistence boundary**, because one mutation's
writes are torn into independent round-trips.

---

## Root cause (proven from code)

Maintaining the invariant on an insert/delete requires touching ≥2 nodes
together (insert a node **and** repoint the follower; delete a node **and**
repoint its follower). The write path tears that apart:

1. `mutations.ts` calls `nodesCollection.insert(x)` **and** `update(follower, …)`.
2. `collection.ts` routes them to **different handlers** — inserts → `onInsert` →
   `POST`, updates → `onUpdate` → `PATCH` (`collection.ts:155-167`).
3. The Worker dispatches each to a **different DO method** — `upsertNodes` vs
   `patchNodes` (`worker/index.ts:151-161`).
4. Each method calls `commitChange` **once** → its **own seq**, its **own**
   broadcast frame (`outline-do.ts:212,238,279`).

So an "insert + repoint" is two writes at two seqs with two echoes.
**Update-only ops** (moves, indent/outdent) collapse to one `PATCH` = one frame =
already atomic — which is why reordering *existing* bullets is reliable and the
damage clusters in create/delete-heavy areas (daily notes, task capture).

Two triggers turn the torn window into *persisted* corruption:

- **(a) dropped/failed half** — one round-trip lands, the other doesn't.
- **(b) fast follow-up** — a second structural edit is computed against the
  half-applied (or, after the optimistic overlay drops but before the echo, the
  reverted-but-stale) state, and persists pointers consistent with the wrong
  picture.

Shapes match the live data exactly: insert path → **fan** (two nodes share a
predecessor); delete path → **dangle** (a pointer to a deleted id).

---

## Why not Effect TS

Cam asked whether to adopt Effect TS to kill this class of bug. Direct answer:
**no, it does not address the cause.**

- **The atomicity gap is at the network/DO boundary**, not in our TS control
  flow. Effect's fibers/structured concurrency tame *in-process* concurrency;
  they don't make two HTTP requests one atomic DO transaction. Only a batched
  request + single DO method does that.
- **TanStack DB already gives us the right primitive** (`createTransaction` with
  one `mutationFn`). The fix is idiomatic and small; Effect would be a large,
  invasive migration (runtime, typed-error plumbing, bundle, team ramp) layered
  onto a working codebase.
- **We already have a typed-error convention** (`errore`). Introducing a second
  error/effect paradigm for one bug is cost without payoff here.

If Effect is desirable for *other* strategic reasons, that's a separate decision
to make on its own merits — it should not be justified by this bug, and it is not
required for this fix.

---

## The fix: two properties

Close both triggers with two properties. Both are required.

### P1 — Atomic batch (closes the intra-op tear and trigger (a))

Every tree-shape mutation persists as **one request → one DO method → one
`commitChange` → one broadcast frame**. All-or-nothing: a failed request rolls
back the whole optimistic op; nothing half-persists.

### P2 — Hold the overlay until the echo (closes trigger (b))

The structural transaction's `mutationFn` does **not resolve until its own echo
has been applied** (cursor ≥ the batch's seq). Because TanStack DB holds
optimistic state until the handler resolves, the readable state never regresses
to "pre-op" while the op is persisted-but-unconfirmed. A follow-up edit therefore
always computes against a state that **includes** the prior edit — never a stale
one.

> P1 alone is insufficient: even with atomic ops, if the overlay drops on HTTP
> 200 before the echo arrives, the view briefly reverts to pre-op and a fast
> follow-up edit re-creates a fan. P2 removes that window. (This is the same
> discipline ElectricCollection uses with `txid`; we use our existing `seq`.)

---

## Design

### Wire format — reuse `ChangeOp`

The client already mirrors the DO's `ChangeOp` union (`realtime.ts:24-27`).
Reuse it as the batch request body — the client sends the same op shape the DO
broadcasts:

```ts
type ChangeOp =
  | { op: 'insert'; value: Node }
  | { op: 'update'; value: Node }   // full post-mutation node
  | { op: 'delete'; key: string }

// POST /api/nodes  body: { ops: ChangeOp[] }   ->   200 { seq: number }
```

### Server

- **`worker/index.ts` `handleNodes` POST:** if body has `ops`, call
  `stub.applyBatch(ops)` and return `{ seq }`. Keep the legacy `{ nodes }` upsert
  branch for the seed path (back-compat during rollout).
- **`outline-do.ts` `applyBatch(ops): number`:** one method, runs in the DO's
  single thread (atomic w.r.t. other requests). Apply each op's SQL
  (insert/upsert/patch/delete), accumulate the canonical post-write ops, then a
  **single** `commitChange(ops)`. Return the new seq. (Refactor `upsertNodes` /
  `patchNodes` / `deleteNodes` to share per-op SQL helpers; `commitChange`
  already returns/owns the seq — expose it.)

### Client

- **`api.ts`:** add `persistBatch(ops: ChangeOp[]): Promise<{ seq: number }>` →
  `POST /api/nodes` with `{ ops }`.
- **`collection.ts`:** add `waitForSeq(seq): Promise<void>` (mirrors the existing
  `waitForNode`). Track the applied cursor in a module-level value updated in
  `applyOps`/snapshot, with a listener set; resolve when cursor ≥ seq.
- **New `src/data/structural.ts` — `runStructural(body)`:** the choke point.

  ```ts
  export function runStructural<T>(body: () => T): T {
    let result!: T
    const tx = createTransaction({
      mutationFn: async ({ transaction }) => {
        const ops = transaction.mutations.map(toChangeOp)   // mixed types -> ops
        const { seq } = await persistBatch(ops)             // P1: one request
        await waitForSeq(seq)                               // P2: hold until echo
      },
    })
    tx.mutate(() => { result = body() })   // body runs sync; result available now
    return result                          // autoCommit -> mutationFn (async)
  }
  ```

  `toChangeOp(m)`: `insert/update → { op, value: m.modified }`, `delete →
  { op: 'delete', key: m.key }`.

### Scope — what routes through `runStructural`

Crisp boundary:

- **Tree-shape ops → `runStructural` (P1+P2):** `insertSibling`,
  `insertChildAtStart`, `appendChild`, `indent`, `outdent`, `moveUp`,
  `moveDown`, `moveNode`, the reparent helpers, `removeNode`, **`history.restore`**
  (it does mixed insert/update/delete — same tear), and any plugin structural
  flow (daily get-or-create, multi-node paste).
- **Field/content ops → unchanged, stay direct (keep the hot path fast):**
  `setText` (per keystroke — must NOT await echo), `toggleCompleted`,
  `toggleCollapsed`, `setIsTask`, `toggleBookmark`. Single-node, single-field →
  inherently one `PATCH` → already atomic. These keep using the collection's
  `onUpdate` handler.

The collection therefore **keeps** `onInsert/onUpdate/onDelete` (for field edits
and the seed); structural ops bypass them via the transaction. No conflict —
structural and field writes don't interleave within a tick.

**Wiring `runStructural` in:** wrap at the editor `commands` boundary
(`OutlineEditor.tsx`) and at `history` undo/redo + plugin entry points, **not**
inside each `mutations.ts` function (keeps `mutations.ts` pure and avoids nested
transactions). `mutations.ts` keeps calling `nodesCollection.insert/update/delete`;
they join whatever ambient transaction `runStructural` opened.

### Why this closes it

- Within an op: all writes are one frame; no remote or local reader ever sees a
  half-applied chain.
- Across ops: the overlay is held until the echo, so a follow-up always reads a
  consistent state that includes prior edits.
- On failure: one request, all-or-nothing; clean rollback, nothing half-persists.

---

## Defense in depth (keep, in addition to the cure)

1. **Keep `healSiblingChains`** (`collection.ts`). Pre-fix corrupted data still
   exists in users' DOs; the heal repairs it on load and is a permanent backstop
   against any unforeseen path. Cheap and idempotent.
2. **Add a dev-only invariant tripwire.** After each structural transaction
   commits, in `import.meta.env.DEV`, assert the chains are clean; `console.error`
   the offending op + parent if not. Turns any regression into an immediate,
   located signal instead of silent drift. Zero cost in prod.

---

## Testing

The current e2e harness **cannot** reproduce this — it mocks `/api/sync` as a
plain snapshot over a synchronous `Map` (`fixtures.ts:189-202`): no per-op echo,
no seq gap, no optimistic window. That's why CI is green while prod corrupts.

1. **Realtime-faithful mock (new `e2e` helper).** Echo per-op `change` frames
   with seqs, with a **controllable delay** between the HTTP response and the WS
   echo, so the optimistic-overlay/echo gap is reproducible.
2. **Reproduce-then-prevent.** A test that fires two rapid structural edits across
   the gap: **fails (fan) on the pre-fix path, passes on the new path.** This is
   the regression that proves the cure.
3. **One-request assertion (deterministic).** A structural op issues **exactly one**
   `/api/nodes` write carrying all ops — directly verifies P1, no timing needed.
4. **Keep** `sibling-chain-repair.spec.ts` (heal regression).
5. Gates: `typecheck`, `typecheck:worker`, `lint`, full `test:e2e`.

---

## Rollout (phased, back-compatible)

1. **Server first.** Add `applyBatch` + the POST `{ops}` branch. Old endpoints
   stay. Deploy. (Old clients keep working.)
2. **Client.** Add `persistBatch`, `waitForSeq`, `runStructural`; route structural
   ops + history restore + plugins through it. Ship behind the now-deployed
   endpoint.
3. **Tripwire + realtime test harness** land with the client change.
4. **Heal stays.** Revisit removing it only after weeks of clean telemetry from
   the tripwire (likely: keep it forever — it's cheap).

Each phase is its own PR.

---

## Risks & open questions

- **P2 latency.** Holding the overlay until echo adds one WS round-trip (~tens of
  ms) before a structural transaction is "confirmed." Optimistic state is already
  visible, so it's invisible to the user — but verify it doesn't stall rapid
  Enter-Enter-Enter. Mitigation: overlays stack (concurrent pending transactions
  are fine), so a follow-up needn't wait for the prior to confirm.
- **`waitForSeq` correctness.** Must resolve on the *originator's own* echo and
  never hang if a snapshot/resync supersedes the seq. Add a timeout that resolves
  (not rejects) on resync, falling back to "trust the snapshot."
- **Nested/compound flows.** Daily get-or-create and paste call several mutations;
  they must run inside **one** `runStructural`, not several. Audit those call
  sites.
- **`createTransaction` autoCommit semantics.** Confirm body runs synchronously
  inside `tx.mutate` (so `mutations.ts` return values still work for focus) and
  commit fires without an explicit `tx.commit()`. Verify against
  `references/transaction-api.md` in the db-core skill.
- **DO `applyBatch` ordering.** Within one frame, ops are absolute and keyed by
  id, so apply order doesn't affect the final state; confirm `applyOps` on the
  client applies the whole frame in one `begin/commit` (it does — `collection.ts:107-115`).

---

## Done criteria

- A structural edit = exactly one `/api/nodes` request and one broadcast frame.
- The reproduce-then-prevent test fails on `main`, passes on the branch.
- Tripwire silent across a manual create/delete/move stress pass.
- `healSiblingChains` finds nothing to repair after the stress pass (no new
  corruption produced).
- All gates green.
