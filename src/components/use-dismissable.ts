// Dismiss-on-outside-interaction for a self-positioning popover/menu that was
// opened by a pointer event (a right-click color picker, the link-edit
// popover, the highlight color menu). Closes on an outside `pointerdown` or on
// Escape. The listeners are attached on a deferred `setTimeout(0)` so the very
// event that opened the surface (the opening click/contextmenu) doesn't
// immediately bubble up and close it again.
//
// The one shared copy of what used to be three byte-identical `useEffect`
// blocks (tag color menu, link-edit popover, highlight color menu). `ref` only
// needs to be read (`.contains`), so it's typed at the `HTMLElement` base --
// a div, form, or any element ref assigns in.

import { useEffect, type RefObject } from "react";

export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening (click/contextmenu) event doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose]);
}
