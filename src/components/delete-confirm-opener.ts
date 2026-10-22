/**
 * Big-subtree deletes ask first (the willy-nilly guard): any delete funnel
 * whose subtree count reaches this threshold routes through the confirm
 * dialog instead of deleting inline. Undo still covers the small ones — the
 * confirmation is for catastrophic scale, so it stays rare on purpose.
 */
export const DELETE_CONFIRM_THRESHOLD = 30;

export interface BigDeleteRequest {
  /** The subtree roots to delete (a single bullet, or a selection run). */
  rootIds: string[];
  /** Pre-computed `countSubtreeNodes` total — what the dialog shows. */
  count: number;
  /** History anchor for the one-undo capture (the acted-on focus key). */
  captureKey: string | null;
}

let opener: ((req: BigDeleteRequest) => void) | null = null;

export function setDeleteConfirmOpener(fn: typeof opener) {
  opener = fn;
}

/**
 * Open the big-delete confirm flow (confirm → sliced progress delete) from any
 * delete funnel — the bullet keymap / Cmd+K verb (`commands.onDeleteNode`) and
 * the selection menu both call this. The dialog itself is mounted once in
 * `__root.tsx` (`DeleteConfirmDialog`), which registers the opener — the
 * `openOpmlImport` pattern.
 */
export function openDeleteConfirm(req: BigDeleteRequest) {
  opener?.(req);
}
