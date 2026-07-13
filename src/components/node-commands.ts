import type { PointerEvent } from "react";

import type { NodeKind } from "../data/schema";

/**
 * The per-bullet command set the editor hands to every row (OutlineRow, the
 * zoomed title, the mobile bar facade). Keeping them as a single object avoids
 * each row importing mutations + focus logic directly. Must be referentially
 * stable, or every row re-renders on every keystroke (ADR 0014).
 */
export interface NodeCommands {
  onTextChange: (id: string, text: string) => void;
  // `caretOffset` is the absolute character offset of the caret within the
  // bullet's text, so the editor can split the line at the caret.
  onEnter: (id: string, caretOffset: number) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  // Move a bullet (and its subtree) up/down among siblings; at the edge it
  // reparents into the parent's adjacent sibling. See ADR 0009.
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  // Delete a bullet and its entire subtree, then focus a neighbor.
  onDeleteNode: (id: string) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
  // Set whether a bullet is a task (checkbox shown/hidden). Clears `kind`.
  onSetTask: (id: string, isTask: boolean) => void;
  // Set the node's kind: "paragraph" (pilcrow, prose) or null (plain bullet).
  // Clears `isTask` -- the kinds are mutually exclusive (ADR 0045).
  onSetKind: (id: string, kind: NodeKind) => void;
  // Open the `/move` destination picker for this bullet.
  onRequestMove: (id: string) => void;
  // Open the `/mirror` destination picker for this bullet (ADR 0022): same
  // picker, but a pick creates a live mirror under the destination.
  onRequestMirror: (id: string) => void;
  onToggleCollapsed: (id: string, collapsed: boolean) => void;
  // `x` is the caret's viewport x at the moment of the keypress, so the
  // landing node can drop the caret at the same column. Omitted for horizontal
  // snaking: up lands at the previous row's end, down at the next row's start.
  onMoveFocus: (id: string, direction: "up" | "down", x?: number) => void;
  // Zoom the outline so this node becomes the temporary root.
  onZoom: (id: string) => void;
  // Drag-to-reorder, hung off the bullet dot. pointerdown arms a drag; click
  // zooms only when no drag happened. See ADR 0010.
  onBulletPointerDown: (id: string, e: PointerEvent) => void;
  onBulletClick: (id: string) => void;
  // Queue focus (and a caret offset within it) for a row that hasn't rendered
  // yet -- the seam bullet a multi-line markdown paste just created (ADR 0044).
  // The editor owns the pendingFocus refs; this is the one command that lets a
  // row hand a caret to a node it doesn't render.
  setPendingFocus: (key: string, offset: number) => void;
}
