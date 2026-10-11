import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  createNodesE,
  deleteNodesE,
  NodesResponseError,
  runPromise,
  sendBatchE,
} from "./nodes-client-effect";

// The transport core is verbatim from kv-client-effect.ts (proven in prod), so
// these tests pin only what 01 ADDS: the `{ seq }` envelope validation, the
// error-channel mapping, the no-retry-on-response policy, and the throw bridge.
// They stub global `fetch` (the realtime.test.ts seam idiom) and never wait out
// a real backoff/timeout — none of the asserted paths enter the retry schedule.

const realFetch = globalThis.fetch;
let calls = 0;
let requestBodies: Array<{ clientId?: string; expectedSeq?: number }> = [];

/** The preconnect member the Workers fetch type carries; no-op in tests. */
const stubPreconnect = {
  preconnect: (
    _url: string | URL,
    _options?: {
      dns?: boolean;
      tcp?: boolean;
      http?: boolean;
      https?: boolean;
    },
  ): void => {},
};

/** Install a fetch that returns `make()` and counts invocations. */
function stubFetch(make: () => Response): void {
  calls = 0;
  requestBodies = [];
  // Test stub, not a real fetch: it ignores all arguments, and the code under
  // test only needs a response promise. preconnect is a no-op to satisfy the
  // full fetch type.
  globalThis.fetch = Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(make());
    },
    stubPreconnect,
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sendBatchE", () => {
  test("returns { seq } on a valid envelope", async () => {
    stubFetch(() => new Response(JSON.stringify({ seq: 7 }), { status: 200 }));
    expect(await runPromise(sendBatchE([]))).toEqual({ seq: 7 });
    expect(calls).toBe(1);
  });

  test("correlates every write from this page and sends expectedSeq only for history batches", async () => {
    stubFetch(() => new Response(JSON.stringify({ seq: 8 }), { status: 200 }));
    await runPromise(createNodesE([]));
    await runPromise(deleteNodesE([]));
    await runPromise(sendBatchE([], 7));

    const clientIds = requestBodies.map((body) => body.clientId);
    expect(clientIds[0]).toEqual(expect.any(String));
    expect(new Set(clientIds).size).toBe(1);
    expect(requestBodies[0]).not.toHaveProperty("expectedSeq");
    expect(requestBodies[1]).not.toHaveProperty("expectedSeq");
    expect(requestBodies[2]).toHaveProperty("expectedSeq", 7);
  });

  test.each([
    ["stale expectedSeq", 409, 6],
    ["server error", 500, undefined],
  ] as const)(
    "a %s fails NodesResponseError with its status and is never retried",
    async (_name, status, expectedSeq) => {
      stubFetch(() => new Response("err", { status }));
      const err = await Effect.runPromise(
        Effect.flip(sendBatchE([], expectedSeq)),
      );
      expect(err).toBeInstanceOf(NodesResponseError);
      if (!(err instanceof NodesResponseError)) throw err;
      expect(err.status).toBe(status);
      expect(calls).toBe(1);
    },
  );

  test("does not retry a guarded restore after losing its acknowledgement", async () => {
    stubFetch(() => {
      throw new TypeError("connection lost after commit");
    });
    const err = await Effect.runPromise(Effect.flip(sendBatchE([], 6)));
    expect(err._tag).toBe("NodesTransportError");
    expect(calls).toBe(1);
  });

  test.each([
    ["a missing seq", JSON.stringify({ ok: true })],
    ["a non-JSON 200 (proxy HTML)", "<html>nope</html>"],
  ])("fails NodesTransportError on %s", async (_name, body) => {
    stubFetch(() => new Response(body, { status: 200 }));
    const err = await Effect.runPromise(Effect.flip(sendBatchE([])));
    expect(err._tag).toBe("NodesTransportError");
  });
});

test("createNodesE / deleteNodesE resolve on 2xx and fail NodesResponseError on 5xx", async () => {
  stubFetch(() => new Response(null, { status: 200 }));
  await runPromise(createNodesE([]));
  await runPromise(deleteNodesE([]));
  expect(calls).toBe(2);

  stubFetch(() => new Response("err", { status: 503 }));
  const err = await Effect.runPromise(Effect.flip(createNodesE([])));
  expect(err._tag).toBe("NodesResponseError");
});
