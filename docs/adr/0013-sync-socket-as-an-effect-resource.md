---
status: accepted
---

# The sync socket is an Effect scoped resource

**Decision.** `src/data/realtime.ts` is an Effect program, not a hand-rolled WebSocket state machine.
The socket is `Socket.makeWebSocket` (Effect's injectable WebSocket, `effect/unstable/socket`) wrapped
in a self-recursive reconnect loop, surfaced to `collection.ts` as a `Stream<SyncEvent>`. One
long-lived fiber on a shared app runtime (`src/data/runtime.ts`, `appRuntime`) consumes that stream
and folds each frame into the TanStack DB sync primitives. The producer is pure — it has no knowledge
of the collection.

**Why.** The old socket worked but was a fragile shape: ~7 mutable flags (`closed`, `everDelivered`,
`attempt`, `forceSnapshot`, `reconnectTimer`, `downHandled`, `helloTimer`), three hand-managed timers,
and `onclose`/`onerror` both funnelling through a `downHandled` latch. That's exactly the
connect/backoff/timeout/cleanup machinery Effect ships as defaults: scoped `acquireRelease`
(guaranteed WS close), backoff math, `Effect.timeout`, fiber interruption as teardown. The fiber's
scope _is_ the lifecycle — no flag bookkeeping. And the dependency it removes is the real prize:
`WebSocketConstructor` is an injectable service, so the reconnect/handshake policy is now
**unit-testable** with a fake socket (`realtime.test.ts`) — the hand-rolled version couldn't be tested
at all; only Playwright (which mocks the socket and never exercises drops) covered it.

**The Stream boundary (not a callback).** The seam between `realtime.ts` and `collection.ts` is a
`Stream<SyncEvent>`, where `SyncEvent` is `Message | InitialError` — every producer→consumer signal,
including the "dropped before first data" lifecycle event, flows in-band through one typed channel the
consumer folds over. This is the end-state shape for a codebase migrating to Effect; a callback
interface (`onMessage`/`onInitialError`) would have been deleted on the next migration slice. The
apply logic in `collection.ts` (snapshot/resume/change → `begin/write/commit` + the seq plumbing) is
_unchanged_ — it moved from `onMessage`'s body into `Stream.runForEach`, re-hosted under a fiber.

**Scope boundary (since narrowed).** This ADR shipped with `waitForSeq`'s Promise/`setTimeout` waiters
left unconverted. Under the Effect-first posture ([ADR 0021](./0021-effect-first-one-schema-language.md))
they since became `waitForSeqE`/`waitForNodeE` in `collection.ts` — the registration lifted with
`Effect.callback`, time-bounded by `Effect.timeoutOrElse` (resolve-on-timeout, the P2 fallback) and
`Effect.timeout` (fail-on-timeout, the daily loser-path) respectively — and `runStructural` now composes
the batch send + echo-hold as ONE Effect, bridged once at its async `mutationFn`. The cursor itself
(`appliedSeq`, advanced by `advanceAppliedSeq`/`resetAppliedSeq`) stays a plain module value with
callback resolves; `appliedSeq → SubscriptionRef` remains a later slice. The echo-hold contract
(ADR 0009) is byte-identical.

## Considered and rejected

- **Keep the callback boundary, Effect internals only.** Lower blast radius, but bakes in a shape the
  Effect migration deletes — writing-to-delete plus a second risky touch of load-bearing realtime.
- **Hand-roll the WebSocket inside `Effect.callback`.** Stays on stable Effect modules (avoids
  `unstable/socket`), but re-implements exactly what `fromWebSocket` already does (open/message/
  error/close → typed errors, scoped close), and forfeits the injectable-constructor testability.

## Consequences

- **Reset-after-stable, not reset-on-every-frame (a deliberate behavior change).** The old code reset
  backoff to 500ms on _any_ received frame, which hot-loops a flapping server (open → one frame → drop,
  repeatedly, reconnecting every ~500ms). v4 `Schedule` has no reset-on-event combinator, so the loop
  resets `attempt` only after a connection survives `STABLE_AFTER` (the hello window). Same fast
  reconnect after a genuinely healthy drop; proper backoff when the connection is actually unhealthy.
- **A frame applies one async hop later** (WS → queue → `runForEach` → `Effect.sync`) than the old
  synchronous `onMessage`. Order and delivery are preserved (FIFO queue + sequential `runForEach`);
  `atomic-structural-writes.spec.ts` (echo timing) is the gate that proves it harmless.
- **New dependency surface: `effect/unstable/socket`.** The `unstable/` namespace can churn across
  betas (we pin `effect@4.0.0-beta.90`). It's a single import behind the `Stream` producer, mirrored in
  the effect-smol source (fetched via `bunx opensrc path Effect-TS/effect-smol`); if it churns, the blast radius is one module.
- **One shared `ManagedRuntime` (`appRuntime`) now exists** as the home for long-lived Effect fibers.
  It's the backbone every subsequent Effect slice forks onto, provisioned by one growing service layer.
- **Frame decoding is now Schema-validated (later pass, done).** `decodeFrame` originally did
  `JSON.parse(...) as ServerMessage` — the last unchecked cast on inbound data, left as a deliberate
  "higher-value pass." The DO→client frames are now decoded against the shared `src/data/wire-schema.ts`
  (see [ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)), closing the outbound half of the
  trust boundary. The discard policy is unchanged — a malformed frame warns and is dropped, not escalated
  to a reconnect (a bad frame from our own DO is a bug to log, not a connection to kill).
