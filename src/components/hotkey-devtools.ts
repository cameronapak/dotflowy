import { getHotkeyManager } from "@tanstack/react-hotkeys";

import { hasWindow } from "../env";

/**
 * Window handle on the singleton hotkey manager (build-flag seam, ADR 0061).
 *
 * `@tanstack/react-hotkeys` keeps every registered hotkey in one global store
 * (`HotkeyManager`). `use-bullet-keymap.ts` registers a bullet's ~20 shortcuts
 * only while that bullet is FOCUSED, so the store holds roughly ONE bullet's
 * worth at a time instead of `visibleRows x ~20`. That bound is what keeps a
 * zoom -- which remounts the whole windowed list -- from burning ~130ms
 * re-registering a keymap for every visible row.
 *
 * Exposing the manager on `window` lets the perf guard (e2e/zoom-perf.spec.ts)
 * read the live registration count and assert that invariant DETERMINISTICALLY
 * -- a count, not a wall-clock budget, so it never flakes on slower CI hardware
 * the way an "is the zoom under N ms" assertion would.
 *
 * Build-flag-gated, NOT DEV-gated (ADR 0061): `import.meta.env.DEV` is false
 * in every `vite build`, so a DEV gate silently compiles the seam out of the
 * exact bundle the specs need. `VITE_HOTKEY_DEVTOOLS=1` (set by
 * scripts/e2e-serve.ts, which boots `bun run cf:dev` with it for parity)
 * keeps the seam compiled into dev AND e2e builds; production builds
 * tree-shake it to zero bytes (verified both ways). Same pattern as
 * the quick-add deferred-resolve seam.
 */
declare global {
  // Present only under the VITE_HOTKEY_DEVTOOLS build flag (see above).
  interface Window {
    __hotkeyManager?: ReturnType<typeof getHotkeyManager>;
  }
}

/** Build-flag gate for the window seam below. Vite statically replaces
 * `import.meta.env.VITE_HOTKEY_DEVTOOLS` at build - presence of the string
 * IS the contract (same mechanism as the VITE_SENTRY_DSN gate in
 * src/instrument.client.ts). */
function isHotkeyDevtoolsOn(value: string | undefined): value is string {
  return typeof value === "string";
}

export function exposeHotkeyManagerForDev(): void {
  if (!isHotkeyDevtoolsOn(import.meta.env.VITE_HOTKEY_DEVTOOLS)) return;
  if (!hasWindow()) return;
  // SAFETY: this module is the sole writer of the hook, and it only ever
  // writes under the build flag above.
  window.__hotkeyManager = getHotkeyManager();
}
