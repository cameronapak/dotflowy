import { useEffect, useSyncExternalStore } from "react";

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
 * is bind the engine's document listeners to the toggle's lifetime.
 */
export function SpotlightController(): null {
  const enabled = useSpotlightEnabled();
  useEffect(() => {
    if (!enabled) return;
    installSpotlight();
    return () => uninstallSpotlight();
  }, [enabled]);
  return null;
}
