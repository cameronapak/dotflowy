import { useEffect, useState } from "react";

/**
 * The height (px) at the bottom of the layout viewport currently covered by the
 * software keyboard, tracked via `window.visualViewport` (ADR 0030).
 *
 * When the on-screen keyboard opens, the VISUAL viewport shrinks but the LAYOUT
 * viewport (what `position: fixed; bottom: 0` is measured against) does not, so a
 * bottom-pinned element sits behind the keyboard. The covered gap is
 * `innerHeight - (visualViewport.height + visualViewport.offsetTop)`; a caller
 * translates its bar up by that amount to ride directly above the keyboard.
 *
 * Returns 0 whenever the viewport isn't shrunk (hardware keyboard / iPad / no
 * `visualViewport` support) — the caller falls back to a real bottom anchor then.
 * Listeners are rAF-throttled; iOS fires `resize`/`scroll` in bursts during the
 * keyboard animation.
 */
export function useKeyboardViewport(): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      // offsetTop covers the case where the page has scrolled within the visual
      // viewport (iOS): the visible band's bottom edge, in layout coordinates, is
      // offsetTop + height. Clamp negatives (transient over-scroll / rounding).
      const gap = window.innerHeight - (vv.height + vv.offsetTop);
      setOffset(gap > 0 ? gap : 0);
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };

    update();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return offset;
}
