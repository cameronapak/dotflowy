import { useViewportSize } from "@react-aria/utils";
import { useEffect, useState } from "react";

/**
 * Whether the software keyboard shrinks the visual viewport. The baseline is the
 * layout viewport's `clientHeight`, not `innerHeight`: when iOS Safari scrolls
 * the page to reveal a caret low on the screen (the last bullet), it reports
 * `innerHeight` as the visible height, so the two match while the keyboard is
 * up. Scale normalizes pinch zoom; 100px ignores browser-chrome changes.
 */
export function softwareKeyboardOpen(viewport: VisualViewport): boolean {
  const layout = Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
  );
  return layout - viewport.height * viewport.scale > 100;
}

/**
 * The visible viewport's height and top edge for the mobile toolbar (ADR 0030).
 * Adobe handles keyboard-aware sizing; the offset follows iOS viewport panning.
 * Size only the toolbar's frame; the editor shell stays at 100% height (ADR 0077).
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
