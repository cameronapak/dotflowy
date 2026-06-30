/** What the destination picker DOES on pick: reparent the run (`move`) or create
 *  a live mirror of each under the destination (`mirror`, ADR 0022). The picker
 *  UI is shared; only the completion + candidate-exclusion root differ. */
export type MoveMode = "move" | "mirror";

let opener: ((nodeIds: string[], mode: MoveMode) => void) | null = null;

export function setMoveDialogOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the destination picker for one node (the `/move` // `/mirror` commands)
 *  or several (node multi-selection's Move / Mirror action -- ADR 0018). A single
 *  id is normalized to a one-element run; `mode` defaults to a plain move. */
export function openMoveDialog(
  nodeIds: string | string[],
  mode: MoveMode = "move",
) {
  opener?.(typeof nodeIds === "string" ? [nodeIds] : nodeIds, mode);
}
