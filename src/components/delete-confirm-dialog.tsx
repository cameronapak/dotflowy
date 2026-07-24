import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { nodesCollection } from "../data/collection";
import { isLunoraSyncEnabled } from "../data/flags";
import { capture, drop } from "../data/history";
import { getLunoraOutlineContext } from "../data/lunora-sync";
import { runStructuralSliced } from "../data/structural";
import { now, planRemoveSubtrees } from "../data/tree";
import { getTreeIndex } from "../data/tree-store";
import {
  setDeleteConfirmOpener,
  type BigDeleteRequest,
} from "./delete-confirm-opener";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * The big-delete confirm + progress dialog — the OPML import dialog's
 * destructive twin. Every delete funnel routes subtrees of
 * `DELETE_CONFIRM_THRESHOLD`+ bullets here (see `delete-confirm-opener.ts`):
 * one dialog carries confirm ("Delete N bullets?") → modal sliced progress →
 * done (a toast; the outline visibly changed) or an error that states nothing
 * was deleted. Mounted once in `__root.tsx`.
 *
 * The commit mirrors the import exactly, inverted: one history `capture` (a
 * single Cmd+Z restores the whole subtree), then `planRemoveSubtrees` applied
 * through ONE `runStructuralSliced` transaction — repoints first, then deletes
 * in ~500-node yielding slices so the progress counter paints instead of the
 * app freezing (a 17k-node cascade is seconds of main-thread work). Still one
 * batch POST → one DO `applyBatch` → chunked frames → one echo-hold. Any fault
 * rolls the optimistic state back and reports "nothing was deleted".
 */

type Stage =
  | { kind: "closed" }
  | { kind: "confirm"; req: BigDeleteRequest }
  | { kind: "deleting"; count: number; applied: number }
  | { kind: "error" };

/** Sliced-apply chunk size — the import dialog's, inverted. */
const DELETE_SLICE_NODES = 500;

export function DeleteConfirmDialog() {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });

  useEffect(() => {
    setDeleteConfirmOpener((req) => setStage({ kind: "confirm", req }));
    return () => setDeleteConfirmOpener(null);
  }, []);

  const onConfirm = async () => {
    if (stage.kind !== "confirm") return;
    const { rootIds, captureKey } = stage.req;
    // Plan from the LIVE index at confirm time (the outline may have synced
    // while the dialog sat open); unknown ids are skipped by the planner.
    const index = getTreeIndex();
    const plan = planRemoveSubtrees(index, rootIds);
    if (plan.deleteIds.length === 0) {
      setStage({ kind: "closed" });
      return;
    }
    const count = plan.deleteIds.length;
    setStage({ kind: "deleting", count, applied: 0 });
    // Let the modal progress state paint before the first slice runs.
    await new Promise((r) => setTimeout(r, 0));

    // ONE undo point BEFORE the batch: a single Cmd+Z restores everything.
    capture(index, captureKey);

    // Lunora: no classic `{ops}` batch — one `removeMany` mutator owns the
    // subtree delete + watermark. Progress is optimistic (apply is sync).
    if (isLunoraSyncEnabled()) {
      const lunora = getLunoraOutlineContext();
      if (!lunora) {
        drop();
        setStage({ kind: "error" });
        return;
      }
      try {
        setStage({ kind: "deleting", count, applied: count });
        const tx = lunora.store.mutators.removeMany({
          userId: lunora.userId,
          nodeIds: [...rootIds],
          updatedAt: now(),
        });
        // Await persistence here (error stage below) — do not also
        // trackLunoraMutation (would double-toast on failure).
        await tx.isPersisted.promise;
        setStage({ kind: "closed" });
        toast.success(
          `Deleted ${count.toLocaleString()} bullets. Cmd+Z restores them.`,
        );
      } catch {
        drop();
        setStage({ kind: "error" });
      }
      return;
    }

    let applied = 0;
    const slices: Array<() => void> = [];
    if (plan.repoints.length > 0) {
      slices.push(() => {
        const ts = now();
        for (const r of plan.repoints) {
          nodesCollection.update(r.id, (draft) => {
            draft.prevSiblingId = r.prevSiblingId;
            draft.updatedAt = ts;
          });
        }
      });
    }
    for (let i = 0; i < plan.deleteIds.length; i += DELETE_SLICE_NODES) {
      const chunk = plan.deleteIds.slice(i, i + DELETE_SLICE_NODES);
      slices.push(() => {
        for (const id of chunk) nodesCollection.delete(id);
        applied += chunk.length;
      });
    }
    try {
      await runStructuralSliced(slices, () =>
        setStage({ kind: "deleting", count, applied }),
      );
      setStage({ kind: "closed" });
      toast.success(
        `Deleted ${count.toLocaleString()} bullets. Cmd+Z restores them.`,
      );
    } catch {
      // The transaction rolled back (a failed slice rolls back inside
      // runStructuralSliced; a failed send rolls back in TanStack), so the
      // outline already matches the captured snapshot — drop the redundant
      // undo point.
      drop();
      setStage({ kind: "error" });
    }
  };

  const open = stage.kind !== "closed";
  const deleting = stage.kind === "deleting";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The modal progress can't be dismissed mid-commit (Escape/backdrop
        // are ignored) — same rule as the import dialog.
        if (!next && !deleting) setStage({ kind: "closed" });
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!deleting}
        data-testid="delete-confirm-dialog"
      >
        {stage.kind === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TriangleAlertIcon className="size-4 text-destructive" />
                Delete {stage.req.count.toLocaleString()} bullets?
              </DialogTitle>
              <DialogDescription data-testid="delete-confirm-summary">
                This deletes{" "}
                {stage.req.rootIds.length > 1
                  ? "the selected nodes"
                  : "this node"}{" "}
                and everything inside — {stage.req.count.toLocaleString()}{" "}
                bullets in total. One undo (Cmd+Z) brings it all back.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                data-testid="delete-cancel"
                onClick={() => setStage({ kind: "closed" })}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                data-testid="delete-confirm"
                onClick={onConfirm}
              >
                Delete {stage.req.count.toLocaleString()} bullets
              </Button>
            </DialogFooter>
          </>
        )}
        {stage.kind === "deleting" && (
          <div
            className="flex flex-col items-center gap-3 py-6"
            data-testid="delete-deleting"
          >
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
            <DialogTitle>Deleting…</DialogTitle>
            <DialogDescription>
              {stage.applied < stage.count
                ? `Removing bullets… ${stage.applied.toLocaleString()} / ${stage.count.toLocaleString()}`
                : `Saving the deletion of ${stage.count.toLocaleString()} bullets as one atomic batch.`}
            </DialogDescription>
          </div>
        )}
        {stage.kind === "error" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TriangleAlertIcon className="size-4 text-destructive" />
                Delete failed
              </DialogTitle>
              <DialogDescription data-testid="delete-error">
                The change could not be saved. Nothing was deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setStage({ kind: "closed" })}
              >
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
