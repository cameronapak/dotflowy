import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Stream } from "effect";
import { Socket } from "effect/unstable/socket";

import type { ServerMessage, SyncEvent } from "./realtime";

import { backoffMillis, makeSyncStream } from "./realtime";

// realtime.ts derives the socket URL from window.location; bun test has no DOM.
Object.assign(globalThis, {
  window: { location: { protocol: "http:", host: "localhost" } },
});

// --- Pure backoff policy ----------------------------------------------------
// The reconnect backoff is the one piece of timing policy worth pinning purely:
// exponential floor from 500ms, capped at 30s, jittered ±20%. (The live loop's
// hello-timeout / reset-after-stable timers are exercised by the fake-socket
// harness + e2e; their delay math is this same function.)

describe("backoffMillis", () => {
  test("exponential floor doubles per attempt (no jitter, rand=0 lower bound)", () => {
    // rand=0 -> factor 0.8, so the floor is scaled by exactly 0.8.
    expect(backoffMillis(0, 0)).toBe(500 * 0.8);
    expect(backoffMillis(1, 0)).toBe(1000 * 0.8);
    expect(backoffMillis(2, 0)).toBe(2000 * 0.8);
    expect(backoffMillis(3, 0)).toBe(4000 * 0.8);
  });

  test("caps at 30s no matter how high the attempt climbs", () => {
    // 500·2^n passes 30s by n=6 (32s); every higher attempt stays capped.
    for (const n of [6, 10, 50, 1000]) {
      expect(backoffMillis(n, 0)).toBe(30_000 * 0.8);
      expect(backoffMillis(n, 1)).toBeCloseTo(30_000 * 1.2, 5);
    }
  });

  test("jitter stays within ±20% of the floor", () => {
    for (const rand of [0, 0.25, 0.5, 0.75, 0.999]) {
      const ms = backoffMillis(2, rand);
      expect(ms).toBeGreaterThanOrEqual(2000 * 0.8);
      expect(ms).toBeLessThanOrEqual(2000 * 1.2);
    }
  });
});

// --- Fake WebSocket harness -------------------------------------------------
// Effect's WebSocketConstructor is an injectable service, so we drive the whole
// reconnect/handshake state machine with a controllable socket and zero network.
// This is the testability the Effect rewrite buys (the old hand-rolled socket
// couldn't be unit-tested at all). Events are driven synchronously; we never
// wait out a real timer, so these stay fast and deterministic.

class FakeWebSocket {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.readyState = 3;
    this.fire("close", { code, reason: "" });
  }
  private fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  // --- test controls ---
  /** Transition to OPEN and fire the `open` event the client is waiting on. */
  driveOpen(): void {
    this.readyState = 1;
    this.fire("open", {});
  }
  /** Deliver a server frame. */
  driveMessage(msg: ServerMessage | string): void {
    this.fire("message", {
      data: typeof msg === "string" ? msg : JSON.stringify(msg),
    });
  }
  /** Simulate an abnormal server-side drop (1006 = no clean close). */
  driveServerClose(code = 1006): void {
    this.readyState = 3;
    this.fire("close", { code, reason: "" });
  }
}

/** Let forked fibers process the events we just drove (real microtasks). */
const settle = Effect.sleep(Duration.millis(10));

interface Harness {
  sockets: FakeWebSocket[];
  collected: SyncEvent[];
}

/** Indexed socket access that narrows away `undefined` (noUncheckedIndexedAccess). */
function nth(sockets: FakeWebSocket[], i: number): FakeWebSocket {
  const ws = sockets[i];
  if (!ws) throw new Error(`expected a fake socket at index ${i}`);
  return ws;
}

/**
 * Run `body` with a fresh fake-socket layer. `body` drives the sockets and
 * asserts; the surrounding scope tears everything down (interrupting the loop's
 * backoff sleep), so no test waits a real timer out.
 */
function withHarness(
  cursor: () => number | null,
  body: (h: Harness, resync: Effect.Effect<void>) => Effect.Effect<void>,
): Promise<void> {
  const sockets: FakeWebSocket[] = [];
  const collected: SyncEvent[] = [];
  const layer = Layer.succeed(Socket.WebSocketConstructor)((() => {
    const ws = new FakeWebSocket();
    sockets.push(ws);
    return ws as unknown as WebSocket;
  }) as (url: string, protocols?: string | Array<string>) => WebSocket);

  const program = Effect.gen(function* () {
    const { events, resync } = yield* makeSyncStream(Effect.sync(cursor));
    yield* Stream.runForEach(events, (e: SyncEvent) =>
      Effect.sync(() => {
        collected.push(e);
      }),
    ).pipe(Effect.forkScoped);
    yield* settle; // let the first connection reach "waiting for open"
    yield* body({ sockets, collected }, resync);
  });

  return Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)));
}

const helloOf = (ws: FakeWebSocket): { type: string; since: number | null } => {
  const first = ws.sent[0];
  if (first === undefined) throw new Error("no hello frame was sent");
  return JSON.parse(first) as { type: string; since: number | null };
};

describe("makeSyncStream", () => {
  test("sends hello with the current cursor on connect", () =>
    withHarness(
      () => 42,
      ({ sockets }) =>
        Effect.gen(function* () {
          expect(sockets.length).toBe(1);
          nth(sockets, 0).driveOpen();
          yield* settle;
          expect(helloOf(nth(sockets, 0))).toEqual({
            type: "hello",
            since: 42,
          });
        }),
    ));

  test("emits decoded frames as Message events in order", () =>
    withHarness(
      () => null,
      ({ sockets, collected }) =>
        Effect.gen(function* () {
          nth(sockets, 0).driveOpen();
          const a: ServerMessage = { type: "snapshot", seq: 1, nodes: [] };
          const b: ServerMessage = { type: "change", seq: 2, ops: [] };
          nth(sockets, 0).driveMessage(a);
          nth(sockets, 0).driveMessage(b);
          yield* settle;
          expect(collected).toEqual([
            { _tag: "Message", message: a },
            { _tag: "Message", message: b },
          ]);
        }),
    ));

  test("resync drops the connection and reconnects ignoring the cursor", () =>
    withHarness(
      () => 99, // a non-null cursor we expect resync to IGNORE
      ({ sockets }, resync) =>
        Effect.gen(function* () {
          nth(sockets, 0).driveOpen();
          nth(sockets, 0).driveMessage({ type: "snapshot", seq: 1, nodes: [] });
          yield* settle;
          expect(helloOf(nth(sockets, 0))).toEqual({
            type: "hello",
            since: 99,
          });

          yield* resync;
          yield* settle;
          // old socket closed, a fresh one opened
          expect(nth(sockets, 0).closedWith).not.toBeNull();
          expect(sockets.length).toBe(2);
          nth(sockets, 1).driveOpen();
          yield* settle;
          // the reconnect ignored the cursor -> full snapshot
          expect(helloOf(nth(sockets, 1))).toEqual({
            type: "hello",
            since: null,
          });
        }),
    ));

  test("emits InitialError when the socket drops before any frame", () =>
    withHarness(
      () => null,
      ({ sockets, collected }) =>
        Effect.gen(function* () {
          nth(sockets, 0).driveOpen();
          nth(sockets, 0).driveServerClose(); // closed before any message
          yield* settle;
          const initialErrors = collected.filter(
            (e) => e._tag === "InitialError",
          );
          expect(initialErrors.length).toBe(1);
        }),
    ));

  test("does NOT emit InitialError once a frame has been delivered", () =>
    withHarness(
      () => null,
      ({ sockets, collected }) =>
        Effect.gen(function* () {
          nth(sockets, 0).driveOpen();
          nth(sockets, 0).driveMessage({ type: "snapshot", seq: 1, nodes: [] });
          yield* settle;
          nth(sockets, 0).driveServerClose(); // drop AFTER delivering
          yield* settle;
          const initialErrors = collected.filter(
            (e) => e._tag === "InitialError",
          );
          expect(initialErrors.length).toBe(0);
        }),
    ));
});
