# 02 — write-path coordination (Semaphore + Ref/Deferred)

Status: Planned. Risk: HIGH (typing hot path; ADRs 0009/0010 behaviors are the bar). Depends on: 01.

See [PRD](../PRD.md). Replace the hand-rolled `Promise` coordination in `api.ts` with Effect primitives,
preserving every tuned behavior.

## Scope

- **`batchTail` → `Semaphore(1)`** (`api.ts:51`). Structural batches serialize so the DO receives them
  in client-call order (each waits for the prior HTTP response, which the DO sends only post-commit).
  `Effect.makeSemaphore(1)` + `withPermits(1)` around `sendBatchE`. The `.catch(() => {})` that keeps a
  failed batch from wedging the queue becomes the semaphore releasing on failure (it does, natively) —
  but the caller's rejection must still propagate (its transaction rolls back).
- **Field coalescer → `Ref` + `Deferred`** (`api.ts:97`). While a PATCH is in flight, later field
  changes merge into a pending map (field-wise last-write-wins); on return the merged latest flushes as
  one ordered PATCH. `Ref<Map<string, Partial<Node>>>` for `fieldPending`; a `Deferred`/latch for "flush
  scheduled"; the in-flight gate is the same `Semaphore(1)` discipline. **No artificial debounce** — the
  optimistic overlay is already on screen; only batch what is already in flight (ADR 0010).
- **Bridge once.** These run inside the existing `appRuntime` world; `api.ts`'s throw-shell still
  `runPromise`s at the TanStack seam. Do **not** introduce a `runPromise` per `updateNodes` call beyond
  the one already there — measure that the per-keystroke path forks/bridges no more than today.

## Acceptance (the ADR 0009/0010 behaviors — non-negotiable)

- **Ordering:** two rapid structural batches persist in call order even when the transport response is
  delayed (the `postDelayMs` seam in `atomic-structural-writes.spec.ts`). Fake-transport unit test with
  controllable resolution asserts B never sends before A's response.
- **Coalescing:** a burst of N field edits while one PATCH is in flight flushes as ~1 merged PATCH, not
  N; the merge is field-wise last-write-wins; no edit is lost on the trailing flush.
- **No added latency:** the optimistic overlay still drops on the PATCH ack; no timer/debounce inserted.
- **Failure isolation:** a failed batch/flush rejects its own caller (rollback) without wedging the
  queue for the next one.
- Existing `atomic-structural-writes.spec.ts` + field-edit specs green, serial. typecheck/test/lint/unit
  green.

## Watch-outs

- This is the file ADR 0010 wrote to cure the "characters jumble while typing" bug. A regression here is
  user-visible scramble + data loss. Lean on the fake-transport tests before touching e2e.
- `Semaphore.withPermits` releases on interruption too — confirm an interrupted/failed batch doesn't
  leave the next one blocked.
- Keep the focused-bullet ignore-own-echo guard (`collection.ts` `echoedText`) untouched — it's the
  other half of ADR 0010 and is not part of this issue.
