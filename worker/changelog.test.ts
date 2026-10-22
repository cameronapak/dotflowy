/**
 * The pure half of the DO's chunked `recordChange` (issue #124). The DO class
 * itself can't run under bun (it needs the workers runtime), so per the repo's
 * "pure logic only" unit-test rule the chunk/seq planning is extracted into
 * `planChangeFrames` and tested here:
 *
 *   - a >500-op batch plans ceil(n/500) frames with consecutive seqs
 *   - op order is preserved across chunk boundaries (every prefix chain-valid)
 *   - a ≤500-op batch plans exactly one frame (today's behavior, unchanged)
 *   - an empty batch plans no frames (the seq never advances on a no-op)
 *
 * The rollback half of the acceptance — a mid-batch throw bumps nothing — is
 * `transactionSync`'s guarantee: `recordChange` writes every changelog row and
 * the seq bump INSIDE the caller's one transaction (unchanged from ADR 0014),
 * so it isn't separately unit-testable without mocking the storage runtime.
 * `planChangeFrames` being side-effect-free (asserted below) is the piece that
 * keeps that guarantee intact: no seq is ever allocated outside the frames the
 * transaction writes.
 */

import { expect, test } from "bun:test";

import type { ChangeOp } from "../src/data/wire-schema";

import { createNode } from "../src/data/tree";
import { canResumeChangelog, planChangeFrames } from "./changelog";

/** n delete ops with distinct, ordered keys — chunking is op-shape-agnostic,
 *  and delete ops keep the big fixtures cheap. */
function deletes(n: number): ChangeOp[] {
  return Array.from(
    { length: n },
    // SAFETY: the literal matches the delete variant of ChangeOp field for field.
    (_, i) => ({ op: "delete", key: `n${i}` }) as ChangeOp,
  );
}

test.each([
  // [ops, lastSeq, expected seqs, expected frame sizes]
  [0, 7, [], []],
  [1, 3, [4], [1]],
  [500, 0, [1], [500]],
  [501, 10, [11, 12], [500, 1]],
  [1300, 42, [43, 44, 45], [500, 500, 300]],
])(
  "planChangeFrames splits %i ops after seq %i into 500-op frames with consecutive seqs, order intact",
  (n, lastSeq, seqs, sizes) => {
    const ops = deletes(n);
    const snapshot = [...ops];
    const frames = planChangeFrames(ops, lastSeq);
    expect(frames.map((f) => f.seq)).toEqual(seqs);
    expect(frames.map((f) => f.ops.length)).toEqual(sizes);
    // Concatenating the frames in seq order reproduces the batch exactly, and
    // the input batch is not mutated.
    expect(frames.flatMap((f) => [...f.ops])).toEqual(ops);
    expect(ops).toEqual(snapshot);
  },
);

test("planChangeFrames chunks heterogeneous ops by count and carries one client id across chunks", () => {
  const ops: ChangeOp[] = [
    { op: "insert", value: createNode({ id: "a", text: "alpha" }) },
    { op: "update", value: createNode({ id: "a", text: "alpha!" }) },
    { op: "delete", key: "b" },
  ];
  const frames = planChangeFrames(ops, 5, 2, "page-1");
  expect(frames).toEqual([
    { seq: 6, ops: [ops[0]!, ops[1]!], clientId: "page-1" },
    { seq: 7, ops: [ops[2]!], clientId: "page-1" },
  ]);
});

test("canResumeChangelog blocks cursors older than a snapshot replacement, then resumes from it", () => {
  // seq 11, oldest retained row 3, resume floor 11 (a snapshot replaced the outline at 11).
  expect(canResumeChangelog(10, 11, 3, 11)).toBe(false);
  expect(canResumeChangelog(11, 11, 3, 11)).toBe(true);
  expect(canResumeChangelog(11, 12, 3, 11)).toBe(true);
});
