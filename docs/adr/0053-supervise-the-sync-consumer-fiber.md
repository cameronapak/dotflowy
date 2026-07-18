# 53. Supervise the inbound-sync consumer fiber

## Status

Accepted.

## Context

The sync socket is an Effect scoped resource (ADR 0013): one long-lived fiber on
`appRuntime` drains a `Stream<SyncEvent>` and folds each frame into the TanStack
DB sync primitives via `applyMessage` (`collection.ts`). The fork was bare:

    const fiber = appRuntime.runFork(Stream.runForEach(events, apply));

`Stream.runForEach` runs the fold in an `Effect.sync`, so a throw inside
`applyMessage` surfaces as a **defect** that DIES the fiber. Nothing restarts it.
The failure mode is nasty and silent: the WebSocket still looks connected (its
scope finalizer never runs — the fiber is dead, not interrupted), no frame is
ever applied again, and because structural writes hold their overlay until their
echo (ADR 0009), every one hangs its echo-wait to the 8s timeout with no signal
to the user. The session is dead but looks alive.

Today this is near-unreachable — the wire schema and the collection schema are
field-for-field identical, and inbound frames are Schema-validated at decode
(ADR 0014), so a malformed frame is dropped by the producer and never reaches
`applyMessage`. But any future drift between the two schemas turns a one-frame
glitch into a permanently, silently dead sync. The fork deserved cheap
supervision.

## Decision

Wrap the drain in a self-recursive supervisor on **one outer fiber**, and split
the failure-handling policy out as a pure, unit-tested function.

`decideSyncRecovery(cause, recoveriesUsed)` (`sync-supervision.ts`) returns:

- **Stop** when the cause is interrupt-only (`Cause.hasInterruptsOnly`) — cleanup
  and same-page account switches tear the fiber down by interrupting it, and that
  is teardown, not a fault. The supervisor re-raises the cause (`Effect.failCause`)
  so the fiber terminates as interrupted; **no recovery, no toast**.
- **Reestablish(delay)** for a genuine fault (a defect/throw) while a bounded
  budget remains — log the cause (`console.error` + `Cause.pretty`, the house
  convention) and re-open the stream after an exponential backoff. Recovery first
  runs `resync` (force the next connection to ignore the cursor), so the server
  replies with a fresh `snapshot` that truncates and replaces the collection —
  healing a _transient_ one-frame glitch.
- **GiveUp** once the budget (`SYNC_RECOVERY_BUDGET = 3`) is spent — stop retrying
  and flip a **visible** persistent "Sync interrupted — reload" toast
  (`notifySyncInterrupted`, same sonner mechanism as the #230 save-failure
  notice). The session can no longer die silently.

The recovery loop lives on the same fiber that cleanup interrupts, so
`Fiber.interrupt(fiber)` still tears everything down — whether it's mid-drain,
mid-backoff, or mid-reestablish. Additive only: `applyMessage`, the wire
protocol, and the cleanup/interrupt path are unchanged.

## Consequences

- **A deterministically-poisonous frame can't hot-loop.** If a bad frame
  re-poisons every snapshot, the budget caps re-establishes at 3 (500ms → 1s → 2s
  backoff) before giving up to the visible notice — no unbounded snapshot-fetch
  loop.
- **Interruption is explicitly excluded from the fault path.** `catchCause` sees
  interrupts too; the `hasInterruptsOnly` gate is load-bearing. An intentional
  teardown never triggers a re-establish or the toast. This is the one thing the
  unit tests pin hardest.
- **The policy is pure and testable.** The interrupt-vs-fault split, the budget
  boundary, and the backoff schedule are covered by `sync-supervision.test.ts`
  without driving the socket. The Effect wiring (catchCause + re-establish on the
  same fiber) is thin glue over the tested decision.
- **Recovery re-runs `Stream.runForEach(events, …)`.** `events` is a
  `Stream.callback`; each run starts a fresh connection loop with its own queue
  and socket. The previous run's scope (and its WS) already finalized when the
  drain failed, so there's no double-subscribe — the socket's own scope finalizer
  is what closes the old WS, exactly as ADR 0013 intends.

## Alternatives considered

- **Visible state only (no recovery).** Flip the "reload" toast on any defect and
  stop. Simpler, but forfeits self-healing of a transient glitch that a fresh
  snapshot would fix. Kept as the give-up fallback, not the first response.
- **Unbounded `Effect.retry`.** Rejected — a deterministic poison frame would
  hot-loop snapshot fetches forever with no user signal.
- **Reintroduce a callback socket with an onError restart.** Rejected — it
  violates ADR 0013's Effect model; supervision belongs at the consumer's fork
  site, in-model.
