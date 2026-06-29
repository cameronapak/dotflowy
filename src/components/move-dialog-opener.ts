let opener: ((nodeIds: string[]) => void) | null = null;

export function setMoveDialogOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the move picker for one node (the `/move` command) or several (node
 *  multi-selection's Move action -- ADR 0018). A single id is normalized to a
 *  one-element run. */
export function openMoveDialog(nodeIds: string | string[]) {
  opener?.(typeof nodeIds === "string" ? [nodeIds] : nodeIds);
}
