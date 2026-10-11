import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useKeyboardViewport } from "../hooks/use-keyboard-viewport";
import { caretPosition } from "./caret-menu-utils";

/** Three 44px rows and the list's 8px padding, leaving an editing line on
 * unusually short visual viewports. Also used to budget Quick-add's draft. */
export function typingSuggestionsHeight(height: number) {
  return Math.max(0, Math.min(140, height - 48));
}

/** A keyboard accessory, not a dialog. It never locks the page or moves focus. */
export function TypingSuggestions({
  children,
  getEditor,
  onDismiss,
}: {
  children: ReactNode;
  getEditor: () => HTMLElement | null;
  onDismiss: () => void;
}) {
  const { height, offsetTop } = useKeyboardViewport();
  const bodyRef = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const editor = getEditor();
  const capture = editor?.closest<HTMLElement>(".quick-add-popup");

  useEffect(() => {
    const body = bodyRef.current;
    if (!present || !editor || !body) return;
    let frame = 0;
    const revealCaret = () => {
      if (document.activeElement !== editor) return;
      const y = caretPosition(editor).y;
      if (capture) {
        const rect = capture.getBoundingClientRect();
        const top =
          rect.top + parseFloat(getComputedStyle(editor).lineHeight) + 4;
        const bottom = rect.bottom - 4;
        if (y > bottom) capture.scrollTop += y - bottom;
        else if (y < top) capture.scrollTop += y - top;
        return;
      }
      // Use the actual resting height, not the maximum or an animated rect.
      const bottom = offsetTop + height - body.offsetHeight - 8;
      const delta = y - bottom;
      if (delta > 1)
        window.scrollBy({
          top: delta,
          behavior: reducedMotion ? "instant" : "smooth",
        });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(revealCaret);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(body);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [present, editor, capture, height, offsetTop, children, reducedMotion]);

  useEffect(() => {
    if (!present) return;
    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !bodyRef.current?.contains(event.target) &&
        !editor?.contains(event.target)
      )
        onDismiss();
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [present, editor, onDismiss]);

  return createPortal(
    <div
      className="typing-suggestions-viewport"
      style={{ top: offsetTop, height }}
    >
      <motion.div
        ref={bodyRef}
        className="typing-suggestions"
        data-exiting={!present ? "" : undefined}
        inert={!present}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: reducedMotion ? 0 : 0.12, ease: "easeOut" }}
        style={{
          maxHeight: typingSuggestionsHeight(height),
          marginBottom:
            height + offsetTop >= window.innerHeight
              ? "env(safe-area-inset-bottom)"
              : 0,
        }}
        // Cancel focus, not the touch pointer sequence: WebKit suppresses
        // the eventual click when touch pointerdown is default-prevented.
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="typing-suggestions-scroll scroll-fade">{children}</div>
      </motion.div>
    </div>,
    capture ?? document.body,
  );
}
