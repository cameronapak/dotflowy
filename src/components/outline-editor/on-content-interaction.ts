import type { MouseEvent as ReactMouseEvent } from "react";
import { blocksCaret } from "../../plugins/registry";

// Delegated mousedown for the content container (Seam B). Chips/links live in
// the contentEditable, so a plain mousedown would drop an editing caret; we
// block that when the pointer is over a plugin surface and let onContentClick
// route it. Reads only the event + a module import (no local state), so it sits
// at module scope -- one binding, not a per-render allocation.
export function onContentMouseDown(e: ReactMouseEvent) {
  if (blocksCaret(e.target as HTMLElement)) e.preventDefault();
}
