import { useEffect, type RefObject } from "react";

/** Keep writing quiet without changing the shell's geometry or editor focus. */
export function useWritingChrome(chromeRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const isNodeText = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      target.matches(".node-text") &&
      target.isContentEditable &&
      target.closest(".outline-shell") ===
        chromeRef.current?.closest(".outline-shell");

    const reveal = () => {
      chromeRef.current?.removeAttribute("data-writing");
    };
    const write = (event: Event) => {
      if (isNodeText(event.target))
        chromeRef.current?.setAttribute("data-writing", "");
    };
    const pointerMove = (event: PointerEvent) => {
      // Touch WebKit emits stationary mouse moves as content scrolls. Ignore
      // those, but accept the first desktop move (its delta can also be zero).
      if (
        event.pointerType !== "touch" &&
        (event.movementX !== 0 ||
          event.movementY !== 0 ||
          window.matchMedia("(any-hover: hover)").matches)
      )
        reveal();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") reveal();
    };
    const focusChanged = () => {
      // Enter can replace the active span and land the caret in a new node.
      queueMicrotask(() => {
        if (!isNodeText(document.activeElement)) reveal();
      });
    };

    // Capture before editor handlers consume input, including IME and paste.
    document.addEventListener("beforeinput", write, true);
    document.addEventListener("compositionstart", write, true);
    document.addEventListener("pointermove", pointerMove, true);
    document.addEventListener("pointerdown", reveal, true);
    document.addEventListener("wheel", reveal, {
      passive: true,
      capture: true,
    });
    document.addEventListener("touchmove", reveal, {
      passive: true,
      capture: true,
    });
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("focusout", focusChanged, true);
    window.addEventListener("blur", reveal);
    return () => {
      document.removeEventListener("beforeinput", write, true);
      document.removeEventListener("compositionstart", write, true);
      document.removeEventListener("pointermove", pointerMove, true);
      document.removeEventListener("pointerdown", reveal, true);
      document.removeEventListener("wheel", reveal, true);
      document.removeEventListener("touchmove", reveal, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("focusout", focusChanged, true);
      window.removeEventListener("blur", reveal);
      reveal();
    };
  }, [chromeRef]);
}
