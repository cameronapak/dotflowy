import { getHotkeyManager } from "@tanstack/react-hotkeys";

/**
 * DEV-only handle on the singleton hotkey manager.
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
 * the way an "is the zoom under N ms" assertion would. Also handy from the dev
 * console. Vite strips the dead `import.meta.env.DEV` branch from production
 * builds, so this ships nothing.
 */
declare global {
  interface Window {
    __hotkeyManager?: ReturnType<typeof getHotkeyManager>;
  }
}

export function exposeHotkeyManagerForDev(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  window.__hotkeyManager = getHotkeyManager();
}
