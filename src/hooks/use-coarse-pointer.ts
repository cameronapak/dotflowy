import { useSyncExternalStore } from "react";

/**
 * A coarse pointer ("this is a finger", not a mouse) -- the ADR 0030 presence
 * seam shared by the mobile actions bar and the quick-add FAB. A media query,
 * not a width breakpoint: it's about input modality, so a touch laptop with a
 * wide screen still counts and a narrow desktop window does not.
 */
function subscribe(onChange: () => void) {
  const mql = window.matchMedia("(pointer: coarse)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}
