import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { waitForNodeE, waitForSeqE } from "./collection";

// Pins the ONE thing easy to get wrong about the echo waiters: they have
// OPPOSITE timeout semantics (issue 03 watch-out). `waitForSeqE` RESOLVES on
// timeout (ADR 0009 P2 fallback — trust the snapshot, never hang/roll back a
// structural tx whose echo was superseded); `waitForNodeE` FAILS on timeout
// (the daily claim loser-path wants to know the node never replicated). A tiny
// timeout against a seq that never arrives / a node id that never appears
// exercises each path without mocking the collection's data flow.

describe("echo waiters: opposite timeout semantics", () => {
  test("waitForSeqE RESOLVES on timeout (never rejects)", async () => {
    // appliedSeq starts at 0; this seq is never reached, so only the timeout
    // can settle it. It must resolve to void, not fail.
    await expect(
      Effect.runPromise(waitForSeqE(Number.MAX_SAFE_INTEGER, 20)),
    ).resolves.toBeUndefined();
  });

  test("waitForNodeE FAILS on timeout", async () => {
    await expect(
      Effect.runPromise(waitForNodeE("node-that-never-syncs", 20)),
    ).rejects.toThrow();
  });
});
