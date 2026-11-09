// Autofocus makes a popover keyboard-ready during commit. Only pointer dismissal
// must wait so the opening click/contextmenu cannot immediately close it.

import { useLayoutEffect, type RefObject } from "react";

export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    const onPointerDown = (e: PointerEvent) => {
      // SAFETY: a pointer event's target is the DOM node hit
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose, enabled]);
}
