import { createTransaction, getActiveTransaction } from "@tanstack/react-db";
import { Effect } from "effect";
import { toast } from "sonner";

import type { ChangeOp } from "./realtime";
import type { Node } from "./schema";

import { persistBatchE } from "./api";
import { nodesCollection, waitForSeqE } from "./collection";
import { NodesLimitError, runPromise } from "./nodes-client-effect";
import { chainDisagreements } from "./sibling-chain";
import { buildTreeIndex, childrenOf } from "./tree";

/**
 * Send one structural batch and hold until its echo — the shared mutationFn body
 * for every structural path below. On the free-tier node ceiling (#170) it
 * surfaces one upgrade toast, then RE-THROWS so the batch still rolls back
 * (the optimistic insert reverts, so the outline never visibly grows past cap).
 * A fixed toast `id` de-dupes a burst of blocked inserts into one notice.
 */
async function persistStructuralBatch(ops: ChangeOp[]): Promise<void> {
  try {
    await runPromise(
      persistBatchE(ops).pipe(Effect.flatMap(({ seq }) => waitForSeqE(seq))),
    );
  } catch (err) {
    if (err instanceof NodesLimitError) {
      toast.error(
        `Free plan limit reached (${err.limit.toLocaleString()} bullets)`,
        {
          id: "node-limit",
          description:
            "Upgrade to Unlimited to keep adding. Your existing outline stays fully editable.",
        },
      );
    }
    throw err;
  }
}

/**
 * The single choke point for STRUCTURAL outline edits — any mutation that
 * relinks the `prevSiblingId` sibling chain (insert/delete a bullet, move,
 * indent/outdent, reparent, undo/redo restore). Wrapping such an edit gives it
 * two guarantees the per-type collection handlers can't (PLAN.md):
 *
 *  - **P1 (atomic):** every `nodesCollection.insert/update/delete` the body runs
 *    joins ONE transaction whose `mutationFn` ships them as a single
 *    `persistBatch` request → one DO frame → one broadcast. An insert-and-repoint
 *    can no longer tear into a POST + a PATCH that land (or fail) separately.
 *  - **P2 (hold-until-echo):** the transaction doesn't resolve until its own
 *    change frame echoes back (`waitForSeq`). Because TanStack DB holds optimistic
 *    state until the handler resolves — and a `createTransaction` op, unlike a
 *    direct `collection.update`, is dropped on completion unless its echo has
 *    landed — this keeps the readable state from ever reverting to pre-op while
 *    the write is in flight, so a fast follow-up edit always computes against a
 *    state that includes the prior one.
 *
 * `body` runs SYNCHRONOUSLY inside `tx.mutate`, so its return value (e.g. a new
 * node id to focus) is available immediately; persistence happens async after.
 *
 * FIELD edits (text, completed, collapsed, isTask, bookmark) deliberately do NOT
 * route through here: each is a single-node, single-field PATCH that is already
 * one atomic frame, and the per-keystroke text path must not await an echo.
 */
export function runStructural<T>(body: () => T): T {
  const { result, persisted } = runStructuralTracked(body);
  // Nobody consumes the outcome here — a failed batch already rolls the
  // transaction back — so mark the derived promise handled to avoid an
  // unhandled-rejection report for every offline structural write.
  persisted.catch(() => {});
  return result;
}

/**
 * `runStructural`, plus a `persisted` promise that settles when the batch's
 * echo has landed (resolves) or the send failed and the optimistic overlay
 * rolled back (rejects). For flows that must REPORT the outcome — the OPML
 * import dialog awaits it to flip from "importing" to success/failure (ADR
 * 0037: any fault means "nothing was imported"). Same single-batch guarantees
 * as `runStructural`; this only exposes the transaction's own completion.
 */
export function runStructuralTracked<T>(body: () => T): {
  result: T;
  persisted: Promise<void>;
} {
  // Nesting guard: a compound flow (e.g. the daily get-or-create, which creates
  // a container then a day) may call runStructural while already inside one.
  // Join the outer transaction so the whole flow is ONE frame; never open a
  // second (which would re-tear the very thing we're fixing). The outer
  // transaction owns persistence, so there is nothing separate to track.
  if (getActiveTransaction())
    return { result: body(), persisted: Promise.resolve() };

  let result!: T;
  const tx = createTransaction({
    mutationFn: async ({ transaction }) => {
      const ops = transaction.mutations.map(toChangeOp);
      // A captured-but-no-op command (e.g. indent at the top of a list) makes no
      // mutations; skip the network round-trip entirely.
      if (ops.length === 0) return;
      // P1 (atomic, writeSem-serialized send) → P2 (hold optimistic until the
      // echo) as ONE Effect program, bridged once here at the async mutationFn
      // seam (ADR 0021). waitForSeqE never fails, so the only rejection — which
      // rolls the transaction back — comes from the batch send (incl. the free
      // node-ceiling 403, which also toasts). A chunked >500-op batch replies
      // with its FINAL seq (worker/outline-do.ts), so the wait spans every frame.
      await persistStructuralBatch(ops);
    },
  });
  tx.mutate(() => {
    result = body();
  });
  if (import.meta.env.DEV) assertTouchedChainsClean(tx.mutations);
  return { result, persisted: tx.isPersisted.promise.then(() => undefined) };
}

/**
 * `runStructuralTracked` for a batch too large to apply in one synchronous
 * burst — the OPML import, where ~18k optimistic inserts lock the main thread
 * for seconds and the modal progress dialog freezes mid-paint (a "hang" to the
 * user, ADR 0037). Applies `slices` as multiple `mutate` calls on ONE
 * manually-committed transaction, yielding to the event loop between slices so
 * the browser paints the progress the caller's `onProgress` just rendered,
 * then commits once. The wire guarantees are UNCHANGED from `runStructural`:
 * still one batch POST → one DO `applyBatch` → one echo-hold → one undo point.
 * Slicing is purely a main-thread scheduling concern, never a wire one.
 *
 * The returned promise settles like `runStructuralTracked`'s `persisted`:
 * resolves once the batch's echo has landed, rejects when anything failed —
 * a slice that throws (schema validation) rolls the whole transaction back
 * first, so failure always means "nothing was imported".
 */
export async function runStructuralSliced(
  slices: ReadonlyArray<() => void>,
  onProgress?: () => void,
): Promise<void> {
  // Nesting guard (same as runStructuralTracked): inside an ambient
  // transaction, apply synchronously — the outer transaction owns persistence,
  // and yielding mid-ambient-transaction would detach the later slices.
  if (getActiveTransaction()) {
    for (const slice of slices) slice();
    return;
  }
  const tx = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction }) => {
      const ops = transaction.mutations.map(toChangeOp);
      if (ops.length === 0) return;
      await persistStructuralBatch(ops);
    },
  });
  try {
    for (const slice of slices) {
      tx.mutate(slice);
      onProgress?.();
      // Yield so the progress update paints before the next slice's burst.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    tx.rollback();
    throw error;
  }
  if (import.meta.env.DEV) assertTouchedChainsClean(tx.mutations);
  await tx.commit();
}

/** A PendingMutation, narrowed to the fields the batch wire format needs. */
type MutationLike = { type: string; key: unknown; modified: unknown };

/** Map an optimistic mutation to the DO's wire op. Insert/update carry the full
 *  post-mutation node (an upsert); the DO recomputes insert-vs-update itself. */
function toChangeOp(m: MutationLike): ChangeOp {
  if (m.type === "delete") return { op: "delete", key: String(m.key) };
  return { op: m.type as "insert" | "update", value: m.modified as Node };
}

/**
 * Dev-only invariant tripwire: after a structural op applies optimistically,
 * assert the sibling chains under every parent it touched are total and acyclic
 * (the canonical order buildTreeIndex renders must equal the persisted
 * `prevSiblingId` chain). A mismatch means this op produced a fan/dangle —
 * exactly the corruption the cure exists to prevent — so surface it loudly and
 * located. Scoped to the touched parents so pre-existing corruption elsewhere
 * (repaired separately by healSiblingChains) doesn't cry wolf. Zero cost in prod.
 */
function assertTouchedChainsClean(mutations: readonly MutationLike[]): void {
  try {
    const index = buildTreeIndex(nodesCollection.toArray as Node[]);
    const parents = new Set<string | null>();
    for (const m of mutations) {
      const mod = m.modified as Node | undefined;
      if (mod && typeof mod === "object") parents.add(mod.parentId);
      const live = index.byId.get(String(m.key));
      if (live) parents.add(live.parentId);
    }
    for (const parentId of parents) {
      const [bad] = chainDisagreements(childrenOf(index, parentId));
      if (bad) {
        console.error(
          "[structural] sibling-chain invariant broken after a structural write",
          {
            parent: parentId,
            node: bad.id,
            expectedPrev: bad.expectedPrev,
            actualPrev: bad.actualPrev,
          },
        );
        return;
      }
    }
  } catch (err) {
    console.error("[structural] invariant check threw", err);
  }
}
