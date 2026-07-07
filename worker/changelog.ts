/**
 * Pure changelog planning for the DO's chunked `recordChange` (issue #124).
 *
 * A large structural batch (e.g. an OPML import) can carry thousands of ops;
 * one changelog row holding the whole batch as a JSON blob would blow past
 * SQLite's 2 MB row cap (a ~17k-node import is ~4–7 MB of ops). So the DO
 * splits a committed batch into ≤ MAX_FRAME_OPS-op frames, EACH with its own
 * consecutive seq, all written inside the caller's single `transactionSync` —
 * atomicity is unchanged (ADR 0009/0014); only the changelog's row
 * granularity changes.
 *
 * Op order is preserved across chunk boundaries: the planner slices the
 * depth-first pre-order batch in order, so every frame prefix a live remote
 * client applies is chain-valid.
 *
 * Pure and workers-types-free on purpose — this is the unit-testable half
 * (worker/changelog.test.ts, the repo's "pure logic only" rule); the SQL half
 * stays in outline-do.ts.
 */

import type { ChangeFrame, ChangeOp } from '../src/data/wire-schema'

/** Max ops per changelog row / broadcast frame. Sized well under the 2 MB
 *  SQLite row cap (500 full-node ops is roughly 150–250 KB of JSON). Distinct
 *  from `MAX_BATCH_NODES` (worker/mcp-tools.ts), which caps one MCP
 *  add_subtree *request* — this caps a committed batch's storage/broadcast
 *  granularity, whatever its source. */
export const MAX_FRAME_OPS = 500

/**
 * Split one committed batch into consecutive-seq frames of ≤ `maxOps` ops,
 * starting at `lastSeq + 1`. An empty batch plans no frames, so the seq never
 * advances on a no-op commit (e.g. a patch that touched no writable columns).
 */
export function planChangeFrames(
  ops: readonly ChangeOp[],
  lastSeq: number,
  maxOps: number = MAX_FRAME_OPS,
): ChangeFrame[] {
  const frames: ChangeFrame[] = []
  for (let i = 0; i < ops.length; i += maxOps) {
    frames.push({ seq: lastSeq + frames.length + 1, ops: ops.slice(i, i + maxOps) })
  }
  return frames
}
