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

import { describe, expect, test } from 'bun:test'

import { makeNode } from '../src/data/tree'
import type { ChangeOp } from '../src/data/wire-schema'
import { MAX_FRAME_OPS, planChangeFrames } from './changelog'

/** n delete ops with distinct, ordered keys — chunking is op-shape-agnostic,
 *  and delete ops keep the big fixtures cheap. */
function deletes(n: number): ChangeOp[] {
  return Array.from({ length: n }, (_, i) => ({ op: 'delete', key: `n${i}` }) as ChangeOp)
}

describe('planChangeFrames', () => {
  test('an empty batch plans no frames — the seq never advances', () => {
    expect(planChangeFrames([], 7)).toEqual([])
  })

  test('a <=MAX_FRAME_OPS batch plans exactly one frame at lastSeq + 1', () => {
    const one = planChangeFrames(deletes(1), 3)
    expect(one).toHaveLength(1)
    expect(one[0]!.seq).toBe(4)
    expect(one[0]!.ops).toHaveLength(1)

    const full = planChangeFrames(deletes(MAX_FRAME_OPS), 0)
    expect(full).toHaveLength(1)
    expect(full[0]!.seq).toBe(1)
    expect(full[0]!.ops).toHaveLength(MAX_FRAME_OPS)
  })

  test('a >MAX_FRAME_OPS batch plans ceil(n/500) frames with consecutive seqs', () => {
    const justOver = planChangeFrames(deletes(MAX_FRAME_OPS + 1), 10)
    expect(justOver).toHaveLength(2)
    expect(justOver.map((f) => f.seq)).toEqual([11, 12])
    expect(justOver.map((f) => f.ops.length)).toEqual([MAX_FRAME_OPS, 1])

    const n = 1300 // ceil(1300/500) = 3
    const frames = planChangeFrames(deletes(n), 42)
    expect(frames).toHaveLength(Math.ceil(n / MAX_FRAME_OPS))
    expect(frames.map((f) => f.seq)).toEqual([43, 44, 45])
    expect(frames.map((f) => f.ops.length)).toEqual([500, 500, 300])
  })

  test('op order is preserved across chunk boundaries (every frame prefix stays chain-valid)', () => {
    const ops = deletes(1201)
    const frames = planChangeFrames(ops, 0)
    // Concatenating the frames in seq order reproduces the batch byte-for-byte.
    expect(frames.flatMap((f) => [...f.ops])).toEqual(ops)
    // And no frame exceeds the cap.
    for (const f of frames) expect(f.ops.length).toBeLessThanOrEqual(MAX_FRAME_OPS)
  })

  test('heterogeneous ops chunk by count, order intact', () => {
    const ops: ChangeOp[] = [
      { op: 'insert', value: makeNode({ id: 'a', text: 'alpha' }) },
      { op: 'update', value: makeNode({ id: 'a', text: 'alpha!' }) },
      { op: 'delete', key: 'b' },
    ]
    const frames = planChangeFrames(ops, 5, 2)
    expect(frames.map((f) => f.seq)).toEqual([6, 7])
    expect(frames[0]!.ops).toEqual([ops[0]!, ops[1]!])
    expect(frames[1]!.ops).toEqual([ops[2]!])
  })

  test('pure: the input batch is not mutated', () => {
    const ops = deletes(750)
    const snapshot = [...ops]
    planChangeFrames(ops, 0)
    expect(ops).toEqual(snapshot)
  })
})
