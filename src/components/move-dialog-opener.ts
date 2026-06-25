let opener: ((nodeId: string) => void) | null = null;

export function setMoveDialogOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the move picker for `nodeId` from anywhere (e.g. the `/move` command). */
export function openMoveDialog(nodeId: string) {
  opener?.(nodeId);
}
