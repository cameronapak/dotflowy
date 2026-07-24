import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { OutlineNode } from "../data/outline-plans";

import { isLunoraSyncEnabled } from "../data/flags";
import {
  RESTORE_SLICE_OPS,
  redo,
  undo,
  type RestorePlan,
} from "../data/history";
import {
  getLunoraOutlineContext,
  trackLunoraMutation,
} from "../data/lunora-sync";
import { runStructural, runStructuralSliced } from "../data/structural";
import { getTreeIndex } from "../data/tree-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

/**
 * The single undo/redo funnel: plan the snapshot restore (`history.ts`), then
 * pick the apply path by diff size. A small diff — the common, keystroke-
 * adjacent case — applies synchronously inside `runStructural`, exactly the
 * pre-plan behavior. A huge one (undoing a 17k-node OPML import or big
 * delete) would lock the main thread for seconds in one burst, so it streams
 * through `runStructuralSliced` behind `HistoryRestoreDialog`'s modal
 * progress — the delete-confirm dialog's "deleting" stage, generalized. Both
 * paths keep the wire guarantees: ONE batch POST → one DO `applyBatch` → one
 * echo-hold.
 *
 * Lunora flag ON: one `restoreNodes` mutator (full target snapshot → server
 * re-diffs via `planRestoreNodes`) — single watermark even for large diffs;
 * modal still shows while awaiting persistence.
 *
 * `setPendingFocus` is only honored on the sync path: during a sliced restore
 * the modal owns focus, and by the time the batch commits the tree-change
 * effect window `FocusPass` consumes has passed — a pending focus set then
 * would go stale and steal the caret on some later, unrelated tree change.
 * The big-delete flow drops the caret the same way.
 */
export function runHistoryRestore(
  kind: "undo" | "redo",
  focusId: string | null,
  setPendingFocus: (id: string) => void,
): void {
  const plan = (kind === "undo" ? undo : redo)(getTreeIndex(), focusId);
  if (!plan) return;

  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (!lunora) {
      plan.revert();
      toast.error("Sync is still starting — try again in a moment.");
      return;
    }
    const nodes: OutlineNode[] = plan.targetNodes.map((n) => ({
      ...n,
      userId: lunora.userId,
    }));
    if (plan.opCount < RESTORE_SLICE_OPS) {
      trackLunoraMutation(
        lunora.store.mutators.restoreNodes({
          userId: lunora.userId,
          nodes,
        }),
      );
      if (plan.focusId) setPendingFocus(plan.focusId);
      return;
    }
    void runLunoraRestore(kind, plan, nodes, lunora.userId);
    return;
  }

  if (plan.opCount < RESTORE_SLICE_OPS) {
    runStructural(() => {
      for (const slice of plan.slices) slice();
      if (plan.focusId) setPendingFocus(plan.focusId);
    });
    return;
  }
  void runSliced(kind, plan);
}

async function runLunoraRestore(
  kind: "undo" | "redo",
  plan: RestorePlan,
  nodes: OutlineNode[],
  userId: string,
) {
  const lunora = getLunoraOutlineContext();
  if (!lunora) {
    plan.revert();
    return;
  }
  const label = kind === "undo" ? "Undoing" : "Redoing";
  openRestoreProgress?.({
    kind: "restoring",
    label,
    total: plan.opCount,
    applied: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const tx = lunora.store.mutators.restoreNodes({ userId, nodes });
    // Optimistic apply already flipped the collection; show full progress.
    openRestoreProgress?.({
      kind: "restoring",
      label,
      total: plan.opCount,
      applied: plan.opCount,
    });
    await tx.isPersisted.promise;
    openRestoreProgress?.({ kind: "closed" });
    toast.success(kind === "undo" ? "Undo complete." : "Redo complete.");
  } catch {
    plan.revert();
    openRestoreProgress?.({ kind: "closed" });
    toast.error(`${label} failed. Nothing was changed.`);
  }
}

async function runSliced(kind: "undo" | "redo", plan: RestorePlan) {
  const label = kind === "undo" ? "Undoing" : "Redoing";
  const show = (applied: number) =>
    openRestoreProgress?.({
      kind: "restoring",
      label,
      total: plan.opCount,
      applied,
    });
  show(0);
  // Let the modal paint before the first slice's burst (the delete dialog's
  // pattern); slices then yield between themselves so progress keeps painting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await runStructuralSliced(plan.slices, () => show(plan.applied()));
    openRestoreProgress?.({ kind: "closed" });
    toast.success(kind === "undo" ? "Undo complete." : "Redo complete.");
  } catch {
    // The transaction rolled back (a failed slice rolls back inside
    // runStructuralSliced; a failed send rolls back in TanStack), so the
    // outline still matches the pre-restore state — put the history stacks
    // back so the same Cmd+Z can retry.
    plan.revert();
    openRestoreProgress?.({ kind: "closed" });
    toast.error(`${label} failed. Nothing was changed.`);
  }
}

export type Stage =
  | { kind: "closed" }
  | { kind: "restoring"; label: string; total: number; applied: number };

// Registered by the mounted dialog (the delete-confirm-opener pattern); a
// restore still proceeds if the dialog is somehow unmounted — it only loses
// the progress display.
let openRestoreProgress: ((stage: Stage) => void) | null = null;

/** Drive the modal progress from any sliced structural apply. Undo/redo is the
 *  original tenant; the big markdown paste (ADR 0044) is the second, which is
 *  why `label` exists. */
export function setRestoreProgress(stage: Stage): void {
  openRestoreProgress?.(stage);
}

/**
 * The sliced restore's modal progress — undo has no natural dialog, so this
 * minimal one exists solely to (a) show the counter and (b) block input while
 * the outline streams through intermediate states. Mounted once in
 * `__root.tsx`; not dismissable mid-commit, and it closes itself.
 */
export function HistoryRestoreDialog() {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });

  useEffect(() => {
    openRestoreProgress = setStage;
    return () => {
      openRestoreProgress = null;
    };
  }, []);

  return (
    <Dialog open={stage.kind === "restoring"} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        data-testid="history-restore-dialog"
      >
        {stage.kind === "restoring" && (
          <div
            className="flex flex-col items-center gap-3 py-6"
            data-testid="history-restoring"
          >
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
            <DialogTitle>{stage.label}…</DialogTitle>
            <DialogDescription>
              {stage.applied < stage.total
                ? `Applying changes… ${stage.applied.toLocaleString()} / ${stage.total.toLocaleString()}`
                : `Saving ${stage.total.toLocaleString()} changes as one atomic batch.`}
            </DialogDescription>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
