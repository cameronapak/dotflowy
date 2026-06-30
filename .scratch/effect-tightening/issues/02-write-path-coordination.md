# 02 — write-path coordination (Semaphore + shared promise)

Status: `batchTail` → `Semaphore` BUILT + green. Field coalescer DESIGNED (below), ready to build TDD.
Risk: HIGH (typing hot path; ADRs 0009/0010 behaviors are the bar). Depends on: 01.

Shipped: `batchTail` (structural serialization) is now `Semaphore.makeUnsafe(1)` + `withPermits(1)` in
`api.ts`; FIFO == client-call order, `withPermits` releases on success/failure/interrupt (no manual
`.catch` tail). Tests: `src/data/api.test.ts` (off-the-wire ordering + failure-doesn't-wedge), unit
126/126, typecheck/lint clean, `atomic-structural-writes.spec.ts` 3/3 (incl. the wire-ordering proof).

## Field coalescer — the faithful port (correction of an earlier call)

Earlier I filed this as "net-neutral, keep the Promise-singleton." That was wrong on two counts, and
the evidence from the vendored `Semaphore.ts` / `Deferred.ts` source corrects it:

1. **It's a simplification, not net-neutral.** The singleton hand-rolls three concerns: an in-flight
   chain (`fieldInFlight`), a wedge-guard (`.catch(() => {})`), and a shared-fate carrier
   (`return fieldFlush`). A 1-permit `Semaphore` **subsumes the first two** (its FIFO queue *is* the
   chain; releasing on failure *is* the wedge-guard), leaving only the shared promise. Fewer moving
   parts, and the "swallow-on-the-chain but propagate-to-the-caller" split that makes the singleton
   subtle becomes structural.
2. **No `Deferred` and no `Ref` are needed** (the old issue title oversold both). The shared per-
   generation **Promise** already carries shared-fate; a `Deferred` would be redundant machinery. The
   pending `Map` is touched only synchronously (JS run-to-completion — see the timing proof below), so a
   `Ref` buys nothing.

### Shared-fate is the one non-negotiable

The naive Effect port — one fiber per `updateNodes`, each draining all-pending on semaphore-acquire —
**breaks** the property ADR 0010 depends on: only the fiber that happened to drain rejects on a failed
send; peers whose edits rode that same batch get their own later no-op fibers and resolve **success**, so
they DON'T roll back though their edit never persisted. Silent data loss on the typing path.

The faithful port keeps **one shared Promise per generation**: every caller that merges into a generation
returns that generation's single `runPromise(flush)` promise, so when the flush fails they all reject
together → all roll back. Shared-fate by construction.

### Design (Option B — Semaphore + shared promise)

```ts
import { Effect, Semaphore } from 'effect'
import { runPromise, updateNodesE } from './nodes-client-effect'

interface FieldGen {
  pending: Map<string, Partial<Node>>
  promise: Promise<void> // shared by every caller that merged into this generation
}

const fieldSem = Semaphore.makeUnsafe(1)
let currentGen: FieldGen | null = null

function startFlush(gen: FieldGen): Promise<void> {
  const flush = fieldSem.withPermits(1)(
    // yieldNow defers the drain past the current synchronous tick so SAME-TICK
    // callers all merge into `gen` first (exact singleton parity — see timing).
    Effect.flatMap(Effect.yieldNow, () =>
      Effect.suspend(() => {
        // Holding the permit ⇒ the prior generation's PATCH has settled. Detach
        // so new callers open a fresh generation, and snapshot everything that
        // coalesced while we waited.
        if (currentGen === gen) currentGen = null
        if (gen.pending.size === 0) return Effect.void
        const updates = [...gen.pending].map(([id, changes]) => ({ id, changes }))
        return updateNodesE(updates)
      }),
    ),
  )
  return runPromise(flush) // existing bridge: rejects with Error (throw-seam contract)
}

export function updateNodes(
  updates: { id: string; changes: Partial<Node> }[],
): Promise<void> {
  // 1. Join (or open) the current generation. MUST assign currentGen + merge
  //    BEFORE starting the flush — see the timing proof.
  let gen = currentGen
  const fresh = !gen
  if (!gen) {
    gen = { pending: new Map(), promise: Promise.resolve() }
    currentGen = gen
  }
  // 2. Merge field-wise last-write-wins (a PATCH carries only changed columns).
  for (const u of updates) {
    const prev = gen.pending.get(u.id)
    gen.pending.set(u.id, prev ? { ...prev, ...u.changes } : { ...u.changes })
  }
  // 3. First caller of this generation arms its flush (after the merge above).
  if (fresh) gen.promise = startFlush(gen)
  return gen.promise
}
```

### Why each piece is load-bearing (grounded in the vendored source)

- **Merge before `startFlush`** (step 2 before step 3). `Semaphore.take` (`Semaphore.ts:205`) acquires
  **synchronously** when the permit is free, and `Effect.runPromise` runs the program synchronously up to
  the first async boundary (the `fetch`). So for the FIRST generation the drain can run *inside* the
  `updateNodes` call that started it. If the merge hadn't happened yet, it would drain an empty map and
  the creator's own edit would never send. Assigning `currentGen` and merging first makes the drain
  read the populated map regardless of acquire timing.
- **`Effect.yieldNow` before the drain.** Without it, a free-permit first generation drains
  synchronously and detaches `currentGen`, so a *second same-tick* caller opens a new generation → two
  PATCHes where the singleton (whose drain is a microtask) sends one. `yieldNow` defers the drain past
  the synchronous tick so same-tick callers all land in the same generation first — exact parity. Cost:
  one scheduler hop on the first send, sub-ms, and the optimistic overlay is already on screen (the
  singleton already pays a microtask here).
- **`Semaphore` FIFO == order + no-wedge.** On release, `updateTakenUnsafe` (`Semaphore.ts:229`) resumes
  `this.waiters` in insertion order via `scheduleTask(_, 0)` (deferred), one per release at 1 permit. So
  generation N+1's flush acquires only after generation N's send settles (in-flight coalescing window),
  in creation order. `withPermits` releases on success **and** failure **and** interrupt, so a failed
  flush can't wedge the next — the `.catch(() => {})` guard becomes structural.
- **Shared `gen.promise`** = `runPromise(flush)` run **once** per generation; every caller returns it →
  shared-fate. Reuses the existing `nodes-client-effect.ts` `runPromise` (maps the typed error → `Error`,
  rejects), so the TanStack throw/rollback contract is byte-identical.
- **Plain `Map`, no `Ref`.** `gen.pending` is mutated only in `updateNodes` (synchronous merge loop, no
  await) and read once in the drain (synchronous `Effect.suspend` body). JS run-to-completion guarantees
  a forked flush fiber cannot interleave into the middle of an `updateNodes` call, and after detach a
  later `updateNodes` writes a *different* gen's map. No concurrent async access → a `Ref` is ceremony.

### Known, benign delta

If two field `updateNodes` calls fire in the **same synchronous tick** AND `yieldNow`'s reschedule
landed differently than the singleton's microtask, they could split into two PATCHes. With `yieldNow`
they don't (parity). Either way it's no data loss and order-preserving — and field edits are per-discrete
-action (separate ticks), so same-tick multi-call is practically unreachable. Documented, not a blocker.

### Rejected alternative: `Deferred` per generation

A `Deferred<void, Error>` settled by `Deferred.succeed/fail` (verified API: `Deferred.ts:772/392`,
`Deferred.await:230`) would decouple the awaitable from the send program. It works, but it's strictly
more machinery than the shared `runPromise(flush)` promise, which already delivers shared-fate. Kept in
reserve only if a future need (e.g. completing the wait from outside the send) appears.

## Tests (TDD — extend `src/data/api.test.ts`'s parked-fetch harness, write FIRST)

1. **Shared-fate failure (the critical one).** Two callers merge into one in-flight-blocked generation;
   that generation's PATCH 500s; **both** promises reject. (The naive port fails this test.)
2. **Coalescing across the in-flight window.** A sends alone; B + C arriving during A's flight flush as
   ONE merged PATCH. 2 PATCHes for 3 edits; the second carries B + C.
3. **Ordering.** Generation B's PATCH never leaves the client before generation A's response lands
   (parked fetch — the unit twin of the e2e field path).
4. **Failure-doesn't-wedge.** Generation A fails (500); generation B still flushes and can succeed.
5. **Field-wise last-write-wins.** Repeated edits to one id merge changes; edits to different ids both
   survive the merge.
6. **No debounce.** The first edit's PATCH is in flight after a tick, not after a timer.

## Acceptance (the ADR 0009/0010 behaviors — non-negotiable)

- All six unit tests above green (shared-fate is the gate).
- Existing field-edit e2e + `atomic-structural-writes.spec.ts` green, serial.
- No added latency: optimistic overlay still drops on the PATCH ack; no timer/debounce inserted.
- `api.ts` public signature byte-identical (`updateNodes(updates): Promise<void>`), TanStack rollback
  path unchanged.
- typecheck + typecheck:test + lint + unit green.

## Watch-outs

- This is the file ADR 0010 wrote to cure the "characters jumble while typing" bug. A regression here is
  user-visible scramble + data loss. Lean on the parked-fetch tests before touching e2e.
- `Semaphore.withPermits` releases on interruption too — an interrupted/failed flush must not block the
  next (the FIFO resume covers this; assert via test 4).
- Keep the focused-bullet ignore-own-echo guard (`collection.ts` `echoedText`) untouched — it's the
  other half of ADR 0010 and is not part of this issue.
