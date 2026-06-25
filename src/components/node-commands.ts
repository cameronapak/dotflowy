import type { PointerEvent } from "react";

/** The per-bullet command set the editor hands to every OutlineNode. */
export interface NodeCommands {
  onTextChange: (id: string, text: string) => void;
  // `caretOffset` is the absolute character offset of the caret within the
  // bullet's text, so the editor can split the line at the caret.
  onEnter: (id: string, caretOffset: number) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  // Move a bullet (and its subtree) up/down among siblings; at the edge it
  // outdents one level in that direction. See ADR 0009.
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  // Delete a bullet and its entire subtree, then focus a neighbor.
  onDeleteNode: (id: string) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
  // Set whether a bullet is a task (checkbox shown/hidden).
  onSetTask: (id: string, isTask: boolean) => void;
  // Open the `/move` destination picker for this bullet.
  onRequestMove: (id: string) => void;
  onToggleCollapsed: (id: string, collapsed: boolean) => void;
  // `x` is the caret's viewport x at the moment of the keypress, so the
  // landing node can drop the caret at the same column. Omitted when there's
  // no caret to preserve (e.g. the zoom title), which lands at the start.
  onMoveFocus: (id: string, direction: "up" | "down", x?: number) => void;
  // Zoom the outline so this node becomes the temporary root.
  onZoom: (id: string) => void;
  // Drag-to-reorder, hung off the bullet dot. pointerdown arms a drag; click
  // zooms only when no drag happened. See ADR 0010.
  onBulletPointerDown: (id: string, e: PointerEvent) => void;
  onBulletClick: (id: string) => void;
}
