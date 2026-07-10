import { Effect, Semaphore } from "effect";

import type { ChangeOp } from "./realtime";
import type { Node } from "./schema";

import {
  createNodesE,
  deleteNodesE,
  type NodesError,
  runPromise,
  sendBatchE,
  updateNodesE,
} from "./nodes-client-effect";

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
 * NOTE: both write-path coordinators are now Effect `Semaphore`s — structural
 * batches (`writeSem`) and the field coalescer (`fieldSem`: generations with a
 * shared per-caller promise that preserves shared-fate failure). See
 * .scratch/effect-tightening issue 02 for the design + timing proof.
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
const writeSem = Semaphore.makeUnsafe(1);

/**
 * Persist a structural mutation as one atomic batch — the Effect core. The DO
 * applies every op and commits a SINGLE change frame, returning its sequence
 * number. `writeSem` serializes batches so concurrent edits persist in order;
 * the permit is held across the SEND only (it releases on the HTTP response, not
 * the echo), so the next batch can send as soon as this one commits. Exposed in
 * Effect shape so `runStructural` can compose the P2 echo-wait (`waitForSeqE`)
 * onto it as ONE program (structural.ts), bridged once at the mutationFn seam.
 */
export const persistBatchE = (
  ops: ChangeOp[],
): Effect.Effect<{ seq: number }, NodesError> =>
  writeSem.withPermits(1)(sendBatchE(ops));

/**
 * Throw-shell over `persistBatchE` for the non-composing callers (and the unit
 * tests). The caller (`runStructural`) waits for the returned seq to echo back
 * before dropping its optimistic overlay; all-or-nothing on failure.
 */
export function persistBatch(ops: ChangeOp[]): Promise<{ seq: number }> {
  return runPromise(persistBatchE(ops));
}

export const createNodes = (nodes: Node[]): Promise<void> =>
  runPromise(createNodesE(nodes));

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
//      "c" is lost (and survives refresh). The field-edit twin of the structural
//      fan that `persistBatch` serializes away.
//   2) Cost. One Worker + Durable Object invocation (a SQL write + a broadcast)
//      PER CHARACTER. A 40-character bullet billed 40 round trips.
//
// The fix is one `Semaphore(1)` (`fieldSem`) plus coalescing into GENERATIONS. A
// generation is a pending field-merge map (field-wise last-write-wins -- correct
// because a PATCH carries only changed columns) plus ONE shared promise. While a
// PATCH is in flight the permit is held, so every later edit MERGES into the open
// generation; when the in-flight PATCH returns the permit releases and the next
// generation drains everything that accumulated as ONE ordered PATCH. The
// semaphore's FIFO queue gives client-call order for free, and it releases on
// failure/interruption too, so a rejected PATCH can't wedge the queue.
//
// Shared-fate (the ADR 0010 invariant): every caller that merges into a
// generation returns that generation's SINGLE `runPromise(flush)` promise, so if
// the flush fails they ALL reject together -> all roll back. The naive
// one-fiber-per-call port breaks this (only the draining fiber would learn of the
// failure); the shared promise is what preserves it.
//
// This deliberately does NOT await the echo (the text path must stay snappy,
// per docs/adr/0010-field-edits-serialize-coalesce-ignore-echoes.md); the overlay still drops on the PATCH ack. The
// companion client guard (the focused bullet ignores echo-driven repaints, see
// collection.ts `echoedText` + OutlineNode) keeps that ack/echo gap from ever
// touching the DOM you're typing into.
//
// See .scratch/effect-tightening issue 02 for the timing proof (why the merge
// must precede arming the flush, and why `yieldNow` buys exact same-tick parity).

interface FieldGen {
  /** Field-wise last-write-wins merge accumulated for this generation. */
  pending: Map<string, Partial<Node>>;
  /** The one promise every caller of this generation shares (shared-fate). */
  promise: Promise<void>;
}

const fieldSem = Semaphore.makeUnsafe(1);
let currentGen: FieldGen | null = null;

/**
 * Arm a generation's flush: wait our turn on the permit, then drain everything
 * that coalesced and PATCH it as one request. `yieldNow` defers the drain past
 * the current synchronous tick so same-tick callers all merge into this
 * generation first; the merge in `updateNodes` runs before this is called, so
 * even a free-permit (synchronous) acquire drains a populated map.
 */
function startFieldFlush(gen: FieldGen): Promise<void> {
  const flush = fieldSem.withPermits(1)(
    Effect.flatMap(Effect.yieldNow, () =>
      Effect.suspend(() => {
        // Holding the permit => the prior generation's PATCH has settled. Detach
        // so new callers open a fresh generation, and snapshot the merge.
        if (currentGen === gen) currentGen = null;
        if (gen.pending.size === 0) return Effect.void;
        const updates = [...gen.pending].map(([id, changes]) => ({
          id,
          changes,
        }));
        return updateNodesE(updates);
      }),
    ),
  );
  return runPromise(flush);
}

export function updateNodes(
  updates: { id: string; changes: Partial<Node> }[],
): Promise<void> {
  // Join the open generation, or open one. Assign `currentGen` and merge BEFORE
  // arming the flush -- a free-permit flush can drain synchronously, so the merge
  // must already be in the map (else this caller's edit sends as an empty batch).
  let gen = currentGen;
  const fresh = !gen;
  if (!gen) {
    gen = { pending: new Map(), promise: Promise.resolve() };
    currentGen = gen;
  }
  for (const u of updates) {
    const prev = gen.pending.get(u.id);
    gen.pending.set(u.id, prev ? { ...prev, ...u.changes } : { ...u.changes });
  }
  if (fresh) gen.promise = startFieldFlush(gen);
  return gen.promise;
}

export const deleteNodes = (ids: string[]): Promise<void> =>
  runPromise(deleteNodesE(ids));
