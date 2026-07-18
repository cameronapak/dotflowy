import { toast } from "sonner";

import { NodesLimitError } from "./nodes-client-effect";

/**
 * The shared "your write didn't land" signal for the core outline path (#230).
 *
 * Both write seams fail by rejecting a promise that TanStack DB turns into an
 * optimistic ROLLBACK — the structural batch (`runStructural`, structural.ts)
 * and the field/insert/delete handlers (collection.ts). Before this, that
 * rejection was swallowed (structural) or merely re-thrown into the void (the
 * handlers), so a failed edit just vanished with no word to the user. This puts
 * one honest toast on that path: the edit was undone, here's why.
 *
 * Two deliberate shapes:
 *  - **Skips `NodesLimitError`.** The free-tier node ceiling (#170) is already
 *    surfaced by `persistStructuralBatch`'s dedicated upgrade toast, and it
 *    re-throws — so this would double-toast it. That case is NOT a mystery
 *    failure; it has its own copy.
 *  - **Fixed toast `id`.** A coalesced burst of field generations (or a rapid
 *    run of structural edits) that all fail offline collapses into ONE notice,
 *    not N stacked toasts. Sonner de-dupes on the id.
 */
export function notifySaveFailed(err: unknown): void {
  if (err instanceof NodesLimitError) return;
  toast.error("Couldn't save your changes", {
    id: "save-failed",
    description:
      "Your recent edits were undone. Check your connection and try again.",
  });
}

/**
 * Await a write promise, and if it rejects, surface the rollback via
 * `notifySaveFailed` before RE-THROWING — the throw is load-bearing: it's what
 * triggers TanStack DB's optimistic rollback, so the failure must propagate.
 * The collection field/insert/delete handlers wrap their persistence call in
 * this so all three share one failure seam (#230).
 */
export async function persistOrNotify<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    notifySaveFailed(err);
    throw err;
  }
}
