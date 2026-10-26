import { Effect, Latch } from "effect";

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
 * Field generations and structural writes share one ordered send lane. A
 * structural submission seals the open generation, so fields from opposite
 * sides of a split cannot coalesce or overtake the split on the wire.
 */

let writeTail = Latch.makeUnsafe(true);

let pendingWrites = 0;
let acknowledgedSeq = 0;
const drained = Latch.makeUnsafe(true);

function trackWrite<A>(
  effect: Effect.Effect<A, NodesError>,
): Effect.Effect<A, NodesError> {
  return Effect.suspend(() => {
    pendingWrites++;
    drained.closeUnsafe();
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingWrites--;
          if (pendingWrites === 0) drained.openUnsafe();
        }),
      ),
    );
  });
}

/** Reserve send order before yielding. Only the HTTP request owns the slot,
 * never its WebSocket echo. Each caller keeps its own failure result. */
function enqueueWrite<A>(
  effect: Effect.Effect<A, NodesError>,
  closesFields = true,
): Effect.Effect<A, NodesError> {
  return trackWrite(
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (closesFields) currentGen = null;
        const previous = writeTail;
        const finished = Latch.makeUnsafe(false);
        writeTail = finished;
        // A canceled queued caller must not release its successor before its
        // predecessor finishes. The request itself remains interruptible.
        return previous.await.pipe(
          Effect.andThen(restore(effect)),
          Effect.ensuring(Effect.sync(() => finished.openUnsafe())),
        );
      }),
    ),
  );
}

/** Replay waits for older writes before planning against the authoritative cursor. */
export const waitForPendingWritesE = Effect.gen(function* () {
  // Let collection mutationFns armed in this tick enter their send lanes.
  yield* Effect.yieldNow;
  yield* drained.await;
  return acknowledgedSeq;
});

export function waitForPendingWrites(): Promise<number> {
  return runPromise(waitForPendingWritesE);
}

/**
 * Persist a structural mutation as one atomic batch — the Effect core. The DO
 * applies every op and commits a SINGLE change frame, returning its sequence
 * number. The send lane serializes field and structural writes in submission
 * order, releasing on the HTTP response, not the echo. Exposed in
 * Effect shape so `runStructural` can compose the P2 echo-wait (`waitForSeqE`)
 * onto it as ONE program (structural.ts), bridged once at the mutationFn seam.
 */
export const persistBatchE = (
  ops: ChangeOp[],
  expectedSeq?: number,
): Effect.Effect<{ seq: number }, NodesError> =>
  enqueueWrite(
    sendBatchE(ops, expectedSeq).pipe(
      Effect.tap(({ seq }) =>
        Effect.sync(() => {
          acknowledgedSeq = Math.max(acknowledgedSeq, seq);
        }),
      ),
    ),
  );

/**
 * Throw-shell over `persistBatchE` for the non-composing callers (and the unit
 * tests). The caller (`runStructural`) waits for the returned seq to echo back
 * before dropping its optimistic overlay; all-or-nothing on failure.
 */
export function persistBatch(ops: ChangeOp[]): Promise<{ seq: number }> {
  return runPromise(persistBatchE(ops));
}

export const createNodes = (nodes: Node[]): Promise<void> =>
  runPromise(enqueueWrite(createNodesE(nodes)));

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
// The fix is an ordered send lane plus coalescing into GENERATIONS. A
// generation is a pending field-merge map (field-wise last-write-wins -- correct
// because a PATCH carries only changed columns) plus ONE shared promise. While a
// request is in flight, later field edits MERGE into the open generation until
// it drains or a structural submission seals it. The next generation drains
// everything accumulated as ONE ordered PATCH. Structural fences prevent a
// pre-split field value from overwriting a later split, or a newly created
// node's text PATCH from arriving before its insertion.
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
// collection.ts `echoedText` + OutlineRow) keeps that ack/echo gap from ever
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

let currentGen: FieldGen | null = null;

/**
 * Arm a generation's flush: reserve our place, then drain everything
 * that coalesced and PATCH it as one request. `yieldNow` defers the drain past
 * the current synchronous tick so same-tick callers all merge into this
 * generation first, without letting a later structural write overtake it.
 */
function startFieldFlush(gen: FieldGen): Promise<void> {
  const flush = Effect.flatMap(Effect.yieldNow, () =>
    Effect.suspend(() => {
      // An older fenced generation must not detach a newer open generation.
      if (currentGen === gen) currentGen = null;
      if (gen.pending.size === 0) return Effect.void;
      const updates = [...gen.pending].map(([id, changes]) => ({
        id,
        changes,
      }));
      return updateNodesE(updates).pipe(
        Effect.tap(({ seq }) =>
          Effect.sync(() => {
            acknowledgedSeq = Math.max(acknowledgedSeq, seq);
          }),
        ),
        Effect.asVoid,
      );
    }),
  );
  return runPromise(enqueueWrite(flush, false));
}

export function updateNodes(
  updates: { id: string; changes: Partial<Node> }[],
): Promise<void> {
  // Join the open generation, or open one. Assign `currentGen` and merge BEFORE
  // arming the flush, so its reservation follows this field submission and the
  // eventual drain includes this caller's changes.
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
  runPromise(enqueueWrite(deleteNodesE(ids)));
