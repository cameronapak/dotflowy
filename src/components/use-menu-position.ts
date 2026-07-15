import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Gap (px) between the caret and the menu, and the minimum breathing room kept
 *  from every viewport edge. */
const CARET_GAP = 6;
const VIEWPORT_MARGIN = 8;

/**
 * Position a caret-anchored menu (the `/` palette, the `#`/`[[` caret menus) so
 * it always stays fully on screen. The menus are `position: fixed` at the caret;
 * near the right or bottom edge the raw caret coords would clip them off the
 * viewport. This measures the rendered menu and clamps: it shifts left when it
 * would overflow the right edge and flips ABOVE the caret when it would overflow
 * the bottom (falling back to a bottom-clamp when there's no room either way).
 *
 * `revalidateKey` re-runs the measurement when the menu's height can change
 * without the caret moving -- pass the item count, since filtering the list as
 * you type grows/shrinks it.
 *
 * `useLayoutEffect` runs before paint, so the clamp lands with no visible jump.
 */
export function useClampedMenuPosition(
  x: number,
  y: number,
  revalidateKey: number,
): { ref: (el: HTMLDivElement | null) => void; style: CSSProperties } {
  const elRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: x,
    top: y + CARET_GAP,
  });

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: prefer the caret x; shift left to fit, never past the margin.
    let left = x;
    if (left + width > vw - VIEWPORT_MARGIN)
      left = vw - VIEWPORT_MARGIN - width;
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

    // Vertical: prefer just below the caret; flip above if the bottom overflows
    // and there's room above, else clamp to the bottom margin.
    let top = y + CARET_GAP;
    if (top + height > vh - VIEWPORT_MARGIN) {
      const above = y - CARET_GAP - height;
      top =
        above >= VIEWPORT_MARGIN
          ? above
          : Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - height);
    }

    setPos((prev) =>
      prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [x, y, revalidateKey]);

  return {
    ref: (el) => {
      elRef.current = el;
    },
    style: { position: "fixed", left: pos.left, top: pos.top },
  };
}
