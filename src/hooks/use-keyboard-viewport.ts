import { useViewportSize } from "@react-aria/utils";
import { useEffect, useState } from "react";

/**
 * The visible viewport's height and top edge for the mobile toolbar (ADR 0030).
 * Adobe handles keyboard-aware sizing; the offset follows iOS viewport panning.
 * Keep the editor's window scrolling intact and size only the toolbar's frame.
 */
export function useKeyboardViewport() {
  const { height } = useViewportSize();
  const [offsetTop, setOffsetTop] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      // Match Adobe's sizing policy: pinch zoom must not move the toolbar frame.
      if (vv.scale > 1) return;
      setOffsetTop(Math.max(0, vv.offsetTop));
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

  return { height, offsetTop };
}
