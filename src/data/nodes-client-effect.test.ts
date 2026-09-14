import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

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
  // Test stub, not a real fetch: it ignores all arguments, and the code under
  // test only needs a response promise. preconnect is a no-op to satisfy the
  // full fetch type.
  globalThis.fetch = Object.assign(() => {
    calls += 1;
    return Promise.resolve(make());
  }, stubPreconnect);
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

  test("fails NodesTransportError on a missing seq", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const err = await Effect.runPromise(Effect.flip(sendBatchE([])));
    expect(err._tag).toBe("NodesTransportError");
  });

  test("fails NodesTransportError on a non-JSON 200 (proxy HTML)", async () => {
    stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
    const err = await Effect.runPromise(Effect.flip(sendBatchE([])));
    expect(err._tag).toBe("NodesTransportError");
  });

  test("fails NodesResponseError on 5xx and does NOT retry", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const err = await Effect.runPromise(Effect.flip(sendBatchE([])));
    expect(err._tag).toBe("NodesResponseError");
    // SAFETY: _tag asserted to be NodesResponseError on the line above.
    expect((err as NodesResponseError).status).toBe(500);
    expect(calls).toBe(1); // a received response is never retried
  });
});

describe("createNodesE / deleteNodesE", () => {
  test("resolve void on 2xx", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await runPromise(createNodesE([]));
    await runPromise(deleteNodesE([]));
    expect(calls).toBe(2);
  });

  test("createNodesE fails NodesResponseError on 5xx", async () => {
    stubFetch(() => new Response("err", { status: 503 }));
    const err = await Effect.runPromise(Effect.flip(createNodesE([])));
    expect(err._tag).toBe("NodesResponseError");
  });
});

describe("runPromise bridge", () => {
  test("rejects (throws) on a typed failure, for TanStack rollback", async () => {
    stubFetch(() => new Response("err", { status: 500 }));
    await expect(runPromise(sendBatchE([]))).rejects.toThrow();
  });
});
