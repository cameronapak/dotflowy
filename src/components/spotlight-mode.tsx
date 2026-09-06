import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import {
  getSpotlightServerSnapshot,
  getSpotlightSnapshot,
  installSpotlight,
  subscribeSpotlight,
  uninstallSpotlight,
} from "../data/spotlight";

/**
 * Whether spotlight focus mode (ADR 0033) is on. Reads the localStorage-backed
 * toggle store, mirroring `useShowCompleted` -- it's a per-browser view
 * preference, not synced document data.
 */
export function useSpotlightEnabled(): boolean {
  return useSyncExternalStore(
    subscribeSpotlight,
    getSpotlightSnapshot,
    getSpotlightServerSnapshot,
  );
}

export { setSpotlightEnabled } from "../data/spotlight";

/**
 * Installs / tears down the spotlight DOM engine when the toggle flips. Rendered
 * once at the root (a sibling of TagColorStyles). Renders nothing -- all it does
 * is bind the engine's document listeners to the toggle's lifetime. LAYOUT
 * effects: the engine pins the breathing-room padding to its pre-toggle value
 * before paint, so the class flip never flashes. The breath animation runs only
 * on an off->on FLIP; mounting with the mode already on (page load) snaps
 * straight to the steady state, matching the old CSS behavior where an initial
 * render does not transition.
 */
export function SpotlightController(): null {
  const enabled = useSpotlightEnabled();
  const prev = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const animate = prev.current === false;
    prev.current = enabled;
    if (!enabled) {
      if (animate) uninstallSpotlight();
      return;
    }
    installSpotlight(animate);
    return () => uninstallSpotlight();
  }, [enabled]);
  return null;
}
