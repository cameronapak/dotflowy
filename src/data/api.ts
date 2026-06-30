import { Semaphore } from 'effect'
import type { Node } from './schema'
import type { ChangeOp } from './realtime'
import {
  createNodesE,
  deleteNodesE,
  runPromise,
  sendBatchE,
  updateNodesE,
} from './nodes-client-effect'

/**
 * Throw-based client for the /api/nodes Worker (which routes to the user's
 * Durable Object). Same-origin, so the Better Auth session cookie rides along
 * automatically. The collection's mutation handlers (collection.ts) call
 * create/update/delete on the write path; the initial snapshot + live reads now
 * arrive over the sync socket (realtime.ts), not a GET here. See
 * docs/adr/0008-sync-via-a-per-user-durable-object.md.
 *
 * These are thin SHELLS over the Effect transport core in nodes-client-effect.ts
 * (the outline twin of kv-api.ts over kv-client-effect.ts): each runs the
 * matching Effect program through `runPromise`, so every outline write inherits
 * the core's retry, 8s timeout, typed errors, and `{ seq }` envelope validation.
 * They keep THROWING on failure on purpose — TanStack DB mutation handlers
 * signal failure by throwing (a throw triggers optimistic rollback), so the
 * throw is now Effect-backed, not a hand-rolled bare fetch.
 * See docs/adr/0021-effect-first-one-schema-language.md.
 *
 * STRUCTURAL writes (insert/delete a bullet — anything that relinks the sibling
 * chain) go through `persistBatch` instead: one request carrying every op, so
 * the DO commits them as one atomic frame. The per-type create/update/delete
 * helpers below stay for FIELD edits (text, completed, …) and the first-run
 * seed. See structural.ts and PLAN.md.
 *
 * NOTE: structural-batch serialization is an Effect `Semaphore` (below). The
 * FIELD coalescer is still a Promise-singleton on purpose — see its own comment
 * and .scratch/effect-tightening issue 02 for why a faithful Effect port is
 * net-neutral there (it must preserve shared-fate failure across coalesced
 * callers, which the singleton already does minimally).
 */

// Serializes structural batches so the DO receives them in client-call order.
// The DO assigns each frame's `seq` in arrival order, but two rapid structural
// edits open independent transactions whose `mutationFn`s fire concurrently —
// nothing pins separate fetches to send order (HTTP/2 multiplexing, the Worker
// dispatch). If batch B reached the DO before batch A, B's repoint of a shared
// follower would be overwritten by A's stale one, re-creating the very fan this
// whole change exists to kill. A 1-permit semaphore admits one batch at a time;
// its FIFO queue makes acquire order == client-call order, and `withPermits`
// holds the permit across the whole request — so the next batch can't leave the
// client until the previous one's HTTP response (sent only after the DO commits)
// lands. Logical order == persisted order. The overlay is already on screen, so
// the added latency is invisible. `withPermits` releases on success, failure,
// AND interruption, so one rejected batch can't wedge the queue (its caller's
// promise still rejects → that transaction rolls back).
const writeSem = Semaphore.makeUnsafe(1)

/**
 * Persist a structural mutation as one atomic batch. The DO applies every op and
 * commits a SINGLE change frame, returning its sequence number; the caller
 * (`runStructural`) waits for that seq to echo back before dropping its
 * optimistic overlay. All-or-nothing: a failed request rolls the whole op back.
 * Calls are serialized (see `writeSem`) so concurrent edits persist in order.
 */
export function persistBatch(ops: ChangeOp[]): Promise<{ seq: number }> {
  return runPromise(writeSem.withPermits(1)(sendBatchE(ops)))
}

export const createNodes = (nodes: Node[]): Promise<void> =>
  runPromise(createNodesE(nodes))

// --- Field-edit PATCH: serialize + coalesce ---------------------------------
//
// FIELD edits (text, completed, collapsed, isTask, bookmark) each open their own
// optimistic transaction -> onUpdate -> updateNodes. Sending one PATCH per call
// has two costs on the per-keystroke text path:
//
//   1) Races. Nothing pins independent fetches to call order (HTTP/2 muxing,
//      Worker dispatch), so PATCH("ab") can reach the DO AFTER PATCH("abc").
//      Last-writer-wins then persists the stale "ab" and broadcasts it as the
//      newest seq -- the echo overwrites the live row with older text and the
//      "c" is lost (and survives refresh). This is the field-edit twin of the
//      P3 fan that `persistBatch` serializes away for structural writes.
//   2) Cost. One Worker + Durable Object invocation (a SQL write + a broadcast)
//      PER CHARACTER. A 40-character bullet billed 40 round trips.
//
// The fix is the same `batchTail` discipline, plus coalescing: while a PATCH is
// in flight, every later field change MERGES into a pending map (field-wise
// last-write-wins -- correct because a PATCH carries only changed columns), and
// when the in-flight request returns we flush the merged latest as ONE ordered
// PATCH. Order is guaranteed (one request at a time) and a burst of N keystrokes
// costs ~1 request per round trip instead of N -- the bulk of the savings, with
// no artificial debounce latency (the optimistic overlay is already on screen).
//
// This deliberately does NOT await the echo (the text path must stay snappy,
// per docs/adr/0010-field-edits-serialize-coalesce-ignore-echoes.md); the overlay still drops on the PATCH ack. The
// companion client guard (the focused bullet ignores echo-driven repaints, see
// collection.ts `echoedText` + OutlineNode) keeps that ack/echo gap from ever
// touching the DOM you're typing into.
let fieldInFlight: Promise<unknown> = Promise.resolve()
let fieldPending: Map<string, Partial<Node>> | null = null
let fieldFlush: Promise<void> | null = null

function scheduleFieldFlush(): Promise<void> {
  if (fieldFlush) return fieldFlush
  fieldFlush = fieldInFlight
    // A failed prior batch must not wedge the queue; its own caller already
    // rejected (rolling back that transaction). Swallow here so the next flush
    // still runs.
    .catch(() => {})
    .then(() => {
      const batch = fieldPending
      fieldPending = null
      fieldFlush = null
      if (!batch || batch.size === 0) return
      const updates = [...batch].map(([id, changes]) => ({ id, changes }))
      const run = runPromise(updateNodesE(updates))
      fieldInFlight = run
      return run
    })
  return fieldFlush
}

export function updateNodes(
  updates: { id: string; changes: Partial<Node> }[],
): Promise<void> {
  if (!fieldPending) fieldPending = new Map()
  for (const u of updates) {
    const prev = fieldPending.get(u.id)
    fieldPending.set(u.id, prev ? { ...prev, ...u.changes } : { ...u.changes })
  }
  return scheduleFieldFlush()
}

export const deleteNodes = (ids: string[]): Promise<void> =>
  runPromise(deleteNodesE(ids))
