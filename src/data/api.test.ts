import { afterEach, describe, expect, test } from "bun:test";

import type { ChangeOp } from "./realtime";

import { persistBatchE, updateNodes, waitForPendingWrites } from "./api";
import { runPromise } from "./nodes-client-effect";
import { createNode } from "./tree";

// Pins ordered outline persistence:
// rapid batches must NOT overlap on the wire (else the DO can reorder them and
// re-tear a sibling chain — ADR 0009), and a failed batch must not wedge the
// queue. A controllable fetch parks each request until the test resolves it, so
// we observe send order directly (the unit twin of the e2e `postDelayMs` seam).

const realFetch = globalThis.fetch;

interface Pending {
  body: string;
  resolve: (r: Response) => void;
}
let pending: Pending[] = [];
let arrival = Promise.withResolvers<void>();
let releaseAll: Response | null = null;

const persistBatch = (ops: ChangeOp[]) => runPromise(persistBatchE(ops));

function installControlledFetch(): void {
  pending = [];
  arrival = Promise.withResolvers<void>();
  releaseAll = null;
  // SAFETY: test stub, not a real fetch: the code under test only calls it with (url, init) and reads init.body.
  globalThis.fetch = ((_url: string, init: { body?: unknown }) =>
    new Promise<Response>((resolve) => {
      pending.push({ body: String(init.body), resolve });
      arrival.resolve();
      arrival = Promise.withResolvers<void>();
      if (releaseAll) resolve(releaseAll.clone());
    })) as typeof fetch;
}

/** A pending request, narrowed away from undefined (noUncheckedIndexedAccess). */
function at(i: number): Pending {
  const p = pending[i];
  if (!p) throw new Error(`expected a pending request at index ${i}`);
  return p;
}

// Cross an event-loop turn before asserting that a queued write stays unsent.
const drain = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
async function requestsArrived(count: number): Promise<void> {
  while (pending.length < count) await arrival.promise;
  await drain();
}
const ok = (seq: number): Response =>
  new Response(JSON.stringify({ seq }), { status: 200 });
const op = (key: string): ChangeOp => ({ op: "delete", key });

test("history's write barrier waits for coalesced fields and structural sends", async () => {
  installControlledFetch();
  const field = updateNodes([{ id: "a", changes: { text: "new" } }]);
  const batch = persistBatch([op("b")]);
  let settled = false;
  const barrier = waitForPendingWrites().then(() => {
    settled = true;
  });
  await requestsArrived(1);
  expect(pending.length).toBe(1);
  expect(settled).toBe(false);
  at(0).resolve(ok(8));
  await requestsArrived(2);
  expect(pending.length).toBe(2);
  expect(settled).toBe(false);
  at(1).resolve(ok(9));
  await Promise.all([field, batch, barrier]);
  expect(settled).toBe(true);
});

test.each([false, true])(
  "field coalescing cannot cross a structural edit (older request held: %s)",
  async (holdOlder) => {
    installControlledFetch();
    const older = holdOlder ? persistBatch([op("unrelated")]) : null;
    if (older) await requestsArrived(1);
    const before = [
      updateNodes([{ id: "a", changes: { text: "old" } }]),
      updateNodes([{ id: "a", changes: { text: "Xafter" } }]),
    ];
    const split = persistBatch([
      { op: "update", value: createNode({ id: "a", text: "X" }) },
      {
        op: "insert",
        value: createNode({ id: "b", prevSiblingId: "a", text: "after" }),
      },
    ]);
    const after = [
      updateNodes([{ id: "a", changes: { text: "Z" } }]),
      updateNodes([{ id: "b", changes: { text: "Yafter" } }]),
    ];
    const writes = [...(older ? [older] : []), ...before, split, ...after];
    try {
      await requestsArrived(1);
      expect(pending.length).toBe(1);
      if (older) {
        at(0).resolve(ok(1));
        await requestsArrived(2);
      }
      const offset = older ? 1 : 0;
      expect(JSON.parse(at(offset).body).updates).toEqual([
        { id: "a", changes: { text: "Xafter" } },
      ]);
      at(offset).resolve(ok(2));
      await requestsArrived(offset + 2);
      expect(pending.length).toBe(offset + 2);
      expect(
        JSON.parse(at(offset + 1).body).ops.map(
          ({ value }: { value: { id: string; text: string } }) => [
            value.id,
            value.text,
          ],
        ),
      ).toEqual([
        ["a", "X"],
        ["b", "after"],
      ]);
      at(offset + 1).resolve(ok(3));
      await requestsArrived(offset + 3);
      expect(pending.length).toBe(offset + 3);
      expect(JSON.parse(at(offset + 2).body).updates).toEqual([
        { id: "a", changes: { text: "Z" } },
        { id: "b", changes: { text: "Yafter" } },
      ]);
      at(offset + 2).resolve(ok(4));
      await Promise.all(writes);
    } finally {
      releaseAll = ok(5);
      for (const request of pending) request.resolve(releaseAll.clone());
      await Promise.allSettled(writes);
    }
  },
);

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("persistBatchE serialization", () => {
  test("a second batch stays off the wire until the first responds", async () => {
    installControlledFetch();
    const p1 = persistBatch([op("a")]);
    const p2 = persistBatch([op("b")]);
    await requestsArrived(1);

    // Only batch A is in flight; B is parked on the semaphore.
    expect(pending.length).toBe(1);
    expect(at(0).body).toContain('"a"');

    at(0).resolve(ok(1));
    await requestsArrived(2);

    // A's response lands → B's request now leaves the client, in order.
    expect(pending.length).toBe(2);
    expect(at(1).body).toContain('"b"');

    at(1).resolve(ok(2));
    expect(await p1).toEqual({ seq: 1 });
    expect(await p2).toEqual({ seq: 2 });
  });

  test("a failed batch rejects its caller but does not wedge the next", async () => {
    installControlledFetch();
    const p1 = persistBatch([op("a")]);
    const p2 = persistBatch([op("b")]);
    await requestsArrived(1);
    expect(pending.length).toBe(1);

    // A 5xx is a received response (not a transport drop), so it never retries.
    at(0).resolve(new Response("boom", { status: 500 }));
    await expect(p1).rejects.toThrow();
    await requestsArrived(2);

    // The permit released on failure → B proceeded.
    expect(pending.length).toBe(2);
    at(1).resolve(ok(2));
    expect(await p2).toEqual({ seq: 2 });
  });
});

// Pins field coalescing: rapid field
// edits serialize + coalesce into one PATCH per round trip, and -- the ADR 0010
// invariant -- every caller that merged into a failed generation rolls back
// together (shared-fate). A field PATCH is `void`-shaped (no `{seq}` body to
// read), so a 200 with any body is success and a 5xx rejects without retrying.
const okField = (): Response => ok(10);

describe("updateNodes field coalescer", () => {
  test("shared-fate: both callers of a failed generation reject", async () => {
    installControlledFetch();
    // Gen 1 = A, sent alone (nothing in flight when it arms).
    const pA = updateNodes([{ id: "a", changes: { text: "a" } }]);
    await requestsArrived(1);
    expect(pending.length).toBe(1);

    // B and C land while gen 1 is in flight -> they share ONE generation.
    const pB = updateNodes([{ id: "b", changes: { text: "b" } }]);
    const pC = updateNodes([{ id: "c", changes: { text: "c" } }]);

    at(0).resolve(okField()); // gen 1 ok -> releases the permit
    await requestsArrived(2);
    expect(pending.length).toBe(2); // gen 2 (B+C merged) now in flight
    expect(at(1).body).toContain('"b"');
    expect(at(1).body).toContain('"c"');

    at(1).resolve(new Response("boom", { status: 500 })); // gen 2 fails
    await expect(pB).rejects.toThrow();
    await expect(pC).rejects.toThrow(); // shared-fate: C rolls back too
    await expect(pA).resolves.toBeUndefined();
  });

  test("coalesces a burst during the in-flight window into one field-wise PATCH", async () => {
    installControlledFetch();
    const pA = updateNodes([{ id: "a", changes: { text: "a1" } }]);
    await requestsArrived(1);
    expect(pending.length).toBe(1);
    expect(at(0).body).toContain("a1");

    // Burst while gen 1 is in flight: same id thrice (overlapping and new
    // fields) + a different id.
    const burst = [
      updateNodes([{ id: "a", changes: { text: "a2" } }]),
      updateNodes([{ id: "a", changes: { completed: true } }]),
      updateNodes([{ id: "a", changes: { text: "a3" } }]),
      updateNodes([{ id: "b", changes: { text: "b1" } }]),
    ];
    await drain();
    expect(pending.length).toBe(1); // gen 2 stays off the wire

    at(0).resolve(okField());
    await requestsArrived(2);
    // One PATCH for the whole burst; last-write-wins per field on `a`.
    expect(pending.length).toBe(2);
    expect(JSON.parse(at(1).body).updates).toEqual([
      { id: "a", changes: { text: "a3", completed: true } },
      { id: "b", changes: { text: "b1" } },
    ]);

    at(1).resolve(okField());
    await Promise.all([pA, ...burst]);
  });

  test("a failed generation does not wedge the next", async () => {
    installControlledFetch();
    const pA = updateNodes([{ id: "a", changes: { text: "a" } }]);
    await requestsArrived(1);
    const pB = updateNodes([{ id: "b", changes: { text: "b" } }]); // gen 2

    at(0).resolve(new Response("boom", { status: 500 })); // gen 1 fails
    await expect(pA).rejects.toThrow();
    await requestsArrived(2);
    expect(pending.length).toBe(2); // permit released -> gen 2 proceeded

    at(1).resolve(okField());
    await expect(pB).resolves.toBeUndefined();
  });
});
