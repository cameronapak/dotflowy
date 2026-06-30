# 03 — echo waiters (Effect.callback + Effect.timeout)

Status: BUILT + green. Risk: MED (callers are React handlers; timeout semantics differ per waiter).
Depends on: 01 (so the structural write composes as one end-to-end Effect program).

Built: `waitForSeq`→`waitForSeqE` and `waitForNode`→`waitForNodeE` (`collection.ts`); `runStructural`
composes `persistBatchE(ops).pipe(Effect.flatMap(({seq}) => waitForSeqE(seq)))` as ONE program through
`runPromise` (`structural.ts`); `persistBatchE` exposed from `api.ts` (writeSem + sendBatchE, permit held
across the SEND only). Tests: `src/data/echo-waiters.test.ts` (the opposite-timeout-semantics watch-out).
Gates: unit 134/134, typecheck + typecheck:test + lint clean, e2e atomic-structural 3/3 + daily-notes
19/19 serial (incl. the claim loser-path + orphaned-mapping materialize). Docs: ADR 0013 scope-boundary
note + AGENTS.md updated (the waiters are no longer "deliberately not Effect-ified").

Design note: used **`Effect.callback`**, not `Deferred` (the issue's original wording). The completion
site (`advanceAppliedSeq`/`resetAppliedSeq`) is synchronous external plumbing that still calls
`w.resolve`, so `callback` lifts the registration without the `doneUnsafe` ceremony a `Deferred` would
need, and keeps the `seqWaiters` set + cursor logic byte-identical. The opposite timeout semantics fall
out of `timeoutOrElse` (resolve) vs `timeout` (fail). Testing: per the repo convention (don't unit-test
the collection/DO data flow — CLAUDE.md), the cursor-advance path stays e2e-covered; the new unit test
pins only the two pure timeout outcomes, which need no mocking.

See [PRD](../PRD.md). Replaces the manual `Promise`-resolver sets in `collection.ts` with `Effect.callback`.

## Scope

- **`waitForSeq` → `Deferred` + `Effect.timeout`** (`collection.ts:130`). The `seqWaiters: Set<{seq,
  resolve}>` + `setTimeout` becomes a registry of `Deferred<void>` keyed by target seq; the sync
  cursor advance completes the matching deferreds; `Effect.timeout(8s)` is the fallback.
  **Semantics: resolve on timeout, never reject** (a snapshot/resync may have superseded the seq, or
  the socket is wedged — fall back to trusting the snapshot). `advanceCursor`/`resetWaiters` complete
  deferreds instead of calling `resolve()`.
- **`waitForNode` → `Deferred` + subscription + `Effect.timeout`** (`collection.ts:147`).
  **Semantics: reject on timeout** (the daily loser-path wants to know the node never replicated). Keep
  the `subscribeChanges` seam; complete the deferred on arrival, `Deferred.fail` on timeout.
- **Compose the structural program.** `structural.ts`'s `mutationFn` currently does
  `await persistBatch(ops); await waitForSeq(seq)`. With 01 + this, it can be one
  `sendBatchE(ops).pipe(Effect.flatMap(({seq}) => waitForSeqE(seq)))` run through the throw-shell — the
  P1→P2 hold expressed as one Effect, bridged once at the TanStack `mutationFn` seam (which is already
  `async`). Do not change the P2 hold-until-echo behavior (ADR 0009).

## Acceptance

- `waitForSeqE` completes when the cursor reaches the seq; **completes (not fails)** on timeout; and on
  a snapshot/reset that supersedes the seq (the `resetWaiters` path). Unit-tested with a fake cursor.
- `waitForNodeE` completes on arrival; **fails** on timeout. The daily claim loser-path behavior is
  unchanged (e2e `daily-notes.spec.ts` green — note the pre-existing parallel flake; run serial).
- The structural `mutationFn` still holds optimistic state until the echo (P2). `atomic-structural-
  writes.spec.ts` green. typecheck/test/lint green.

## Watch-outs

- The two waiters have **opposite** timeout semantics — don't unify them into one helper that picks one.
- `waitForSeq`'s timeout resolving is load-bearing (ADR 0009 P2 fallback): a reject would hang or
  roll back a structural tx whose echo was legitimately superseded.
- Callers are React event handlers; the bridge stays at the `mutationFn`/handler boundary. No
  `Effect.runPromise` added mid-render.
