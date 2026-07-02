import {
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Latch,
  Queue,
  Random,
  Ref,
  Schema,
  Stream,
} from 'effect'
import { Socket } from 'effect/unstable/socket'
import { ServerMessageSchema } from './wire-schema'
import type { ServerMessage } from './wire-schema'

// Re-export the wire types so this module stays the client's import surface for
// them (collection.ts, api.ts, structural.ts, ... all import from './realtime').
export type { ChangeOp, ServerMessage } from './wire-schema'

/**
 * The realtime sync transport: one WebSocket per tab to the per-user Durable
 * Object (`/api/sync`), carrying outline changes live. This module owns only the
 * socket — connect, the `hello` handshake, frame decoding, reconnect/backoff,
 * and forced resync. Applying frames to the collection lives in collection.ts,
 * which holds the TanStack DB sync primitives.
 *
 * It's modelled as an Effect scoped resource (docs/adr/0013-sync-socket-as-an-effect-resource.md):
 * the WebSocket is `Socket.makeWebSocket` (scoped acquire/release — guaranteed
 * close), reconnect is a self-recursive backoff loop, and the whole thing is
 * surfaced as a `Stream<SyncEvent>` the consumer folds over. There are no
 * mutable lifecycle flags or hand-managed timers; the fiber's scope is the
 * lifecycle. The producer is pure — it has zero knowledge of the collection.
 *
 * Budget: idle hibernated sockets cost nothing and outgoing broadcasts are free,
 * so this is ~$0 over the base plan (see docs/adr/0008-sync-via-a-per-user-durable-object.md). The cost trap is
 * the legacy `ws.accept()` on the server, which we never use.
 *
 * Browser-only: collection.ts guards the `/` prerender, so this never runs
 * server-side (opening a WebSocket there would throw).
 */

// --- Wire protocol ----------------------------------------------------------
// `ChangeOp` / `ServerMessage` (and the `ServerMessageSchema` decoder below) are
// imported from the shared wire module ./wire-schema — one leaf the client and
// the Worker both derive from, so the socket decoder and the DO broadcaster
// can't drift. See docs/adr/0013.

/**
 * What the sync stream emits. `Message` is a decoded server frame. `InitialError`
 * is the one lifecycle signal the consumer needs: a connection dropped BEFORE
 * this client ever synced any data (offline / server down / auth lost). The
 * consumer uses it to mark ready + record the failure, so first-run bootstrap
 * won't seed over a real-but-unreachable outline. It fires at most once — only
 * before the first `Message` — and is in-band (no side callback) so the consumer
 * folds every signal over one stream.
 */
export type SyncEvent =
  | { _tag: 'Message'; message: ServerMessage }
  | { _tag: 'InitialError'; error: Error }

/** The producer surface: a stream of events + a control effect to force resync. */
export interface SyncStream {
  /** Server frames + `InitialError`, in connection order. */
  events: Stream.Stream<SyncEvent, never, Socket.WebSocketConstructor>
  /** Force a full resync: the current connection drops and the next one ignores
   *  the cursor, so the server replies with a fresh snapshot the collection
   *  truncates onto. */
  resync: Effect.Effect<void>
}

/** Exponential backoff floor. */
const BASE_BACKOFF = Duration.millis(500)
/** Cap the exponential backoff between reconnect attempts. */
const MAX_BACKOFF = Duration.seconds(30)
/** If the `hello` reply never arrives, treat the socket as dead and retry. */
const HELLO_TIMEOUT = Duration.seconds(8)
/** A connection alive at least this long has proven itself healthy, so its next
 *  drop reconnects fast (backoff resets) instead of continuing the exponential
 *  climb. Reusing the hello window: a connection past it has delivered. */
const STABLE_AFTER = HELLO_TIMEOUT

/** Raised when a socket opens but the server never replies to `hello`. */
class HelloTimeoutError extends Data.TaggedError('HelloTimeoutError')<{}> {}

function syncUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/sync`
}

/** Decode inbound `ServerMessage`s (schema-derived exit, no throw). */
const decodeServerMessage = Schema.decodeUnknownExit(ServerMessageSchema)

/** Decode one inbound frame against the shared `ServerMessageSchema` (ADR 0013):
 *  the last unchecked cast on inbound data is now a real validation. Two failure
 *  modes — malformed JSON or a shape the schema rejects — both drop the frame
 *  with a warn and return null.
 *
 *  Escalation: a bad frame mid-stream (after the hello handshake) is simply not
 *  applied — the connection stays open, unchanged from before. A bad *first*
 *  frame (before the handshake completes) leaves the hello `Deferred` unresolved,
 *  so the watchdog eventually treats the socket as un-replied and reconnects —
 *  the same FAIL-SAFE path as a dropped connection (InitialError → the bootstrap
 *  gate declines to seed over the real-but-unsyncable outline). In practice the
 *  DO and this decoder share one schema (wire-schema.ts) and the `nodes` columns
 *  are NOT NULL, so a real DO frame can't fail decode; this is the guard's edge,
 *  not a live path. */
function decodeFrame(data: string): ServerMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch (e) {
    console.warn('realtime: malformed sync frame (bad JSON)', e)
    return null
  }
  const exit = decodeServerMessage(raw)
  if (Exit.isSuccess(exit)) return exit.value
  console.warn('realtime: sync frame failed schema validation', exit.cause)
  return null
}

/**
 * Backoff for the nth consecutive failed attempt (n starts at 0): the exponential
 * floor `min(30s, 500ms·2^n)` scaled by a ±20% jitter factor derived from `rand`
 * (a uniform [0,1)). Pure so the policy is unit-testable without a clock.
 */
export function backoffMillis(n: number, rand: number): number {
  const ceil = Duration.toMillis(MAX_BACKOFF)
  const floor = Math.min(ceil, Duration.toMillis(BASE_BACKOFF) * 2 ** n)
  return floor * (0.8 + 0.4 * rand)
}

/** `backoffMillis` as a jittered Effect delay (Effect `Random`, so tests that
 *  need the live loop can still pin it via a seeded Random). */
const backoffDelay = (n: number): Effect.Effect<Duration.Duration> =>
  Effect.map(Random.next, (r) => Duration.millis(backoffMillis(n, r)))

/**
 * Build the sync stream. Allocates the per-session state (backoff counter, the
 * "ever delivered" + "force snapshot" flags, the resync latch) shared by the
 * connect loop and the returned `resync` control, which is why it's an Effect.
 *
 * `cursor` is read fresh at every (re)connect to build `hello { since }`, so the
 * server replies with only what this client missed (null -> full snapshot).
 */
export const makeSyncStream = (
  cursor: Effect.Effect<number | null>,
): Effect.Effect<SyncStream> =>
  Effect.gen(function* () {
    // Consecutive-failure count driving the backoff. Reset to 0 once a connection
    // proves stable (STABLE_AFTER), so a healthy drop reconnects fast.
    const attempt = yield* Ref.make(0)
    // Has ANY frame ever arrived this session? Gates InitialError.
    const everDelivered = yield* Ref.make(false)
    // The next connect should ignore the cursor (a pending resync).
    const forceSnapshot = yield* Ref.make(false)
    // Opened by `resync` to drop the current connection; closed at each connect
    // so a resync requested while disconnected doesn't interrupt the fresh
    // connection it asked for (forceSnapshot already carries the intent).
    const resyncLatch = yield* Latch.make(false)

    const events = Stream.callback<SyncEvent, never, Socket.WebSocketConstructor>((out) => {
      // One connection attempt. Fails on drop or hello-timeout (-> backoff and
      // reconnect); succeeds when `resync` opens the latch (-> reconnect now).
      const connectOnce = Effect.scoped(
        Effect.gen(function* () {
          yield* resyncLatch.close
          const force = yield* Ref.getAndSet(forceSnapshot, false)
          const since = force ? null : yield* cursor

          const socket = yield* Socket.makeWebSocket(syncUrl())
          const write = yield* socket.writer
          const firstFrame = yield* Deferred.make<void>()

          const handler = (raw: string) =>
            Effect.gen(function* () {
              const msg = decodeFrame(raw)
              if (!msg) return
              yield* Ref.set(everDelivered, true)
              yield* Deferred.succeed(firstFrame, undefined)
              yield* Queue.offer(out, { _tag: 'Message', message: msg })
            })

          // Send `hello` the moment the socket opens. A failed send means the
          // socket is already dead; the watchdog/run will surface that.
          const onOpen = write(
            JSON.stringify({ type: 'hello', since }),
          ).pipe(Effect.ignore)
          const run = socket.runString(handler, { onOpen })

          // Reset-after-stable: if this connection survives STABLE_AFTER, clear
          // the backoff counter. Forked into the connection scope, so a drop
          // before then interrupts it and the backoff keeps climbing.
          yield* Effect.forkScoped(
            Effect.sleep(STABLE_AFTER).pipe(Effect.andThen(Ref.set(attempt, 0))),
          )

          // Hello-reply watchdog: the first frame must arrive within
          // HELLO_TIMEOUT, else fail (reconnect). Once it has arrived, step aside
          // (`Effect.never`) so `run` owns the connection's lifetime.
          const watchdog = Effect.sleep(HELLO_TIMEOUT).pipe(
            Effect.andThen(Deferred.isDone(firstFrame)),
            Effect.flatMap((delivered) =>
              delivered ? Effect.never : Effect.fail(new HelloTimeoutError()),
            ),
          )

          // First to settle wins: `run` failing (drop) or `watchdog` failing
          // (hello-timeout) ends the connection as a failure; the latch opening
          // (resync) ends it as a success.
          yield* Effect.raceFirst(
            Effect.raceFirst(run, watchdog),
            resyncLatch.await,
          )
        }),
      )

      // The forever loop. On a failed connection, surface InitialError (if no
      // data ever arrived) then back off; on a resync success, reconnect at once.
      const loop: Effect.Effect<void, never, Socket.WebSocketConstructor> =
        Effect.gen(function* () {
          const exit = yield* Effect.exit(connectOnce)
          if (Exit.isFailure(exit)) {
            const delivered = yield* Ref.get(everDelivered)
            if (!delivered) {
              yield* Queue.offer(out, {
                _tag: 'InitialError',
                error: new Error('sync socket closed before initial data'),
              })
            }
            const n = yield* Ref.getAndUpdate(attempt, (x) => x + 1)
            yield* Effect.sleep(yield* backoffDelay(n))
          }
          return yield* Effect.suspend(() => loop)
        })

      return loop
    })

    // Set the intent BEFORE opening the latch, so by the time the loop wakes and
    // reconnects, `forceSnapshot` is already true (the next connect ignores the
    // cursor). Opening first would race the loop reading a not-yet-set flag.
    const resync = Ref.set(forceSnapshot, true).pipe(
      Effect.andThen(resyncLatch.open),
      Effect.asVoid,
    )

    return { events, resync }
  })
