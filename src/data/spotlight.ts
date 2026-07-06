/**
 * Spotlight focus mode (ADR 0033). When enabled, the outline dims to 0.3 while a
 * bullet is focused -- EXCEPT that focused bullet, which stays full -- so the
 * line you're editing stands out. Single-node by design: dimmed context is still
 * legible at 0.3, so one bright line against a uniform dim field reads calmer
 * than a ladder of lit ancestors, and it matches the intent (focus on the node).
 *
 * Two halves:
 *  1. A localStorage-backed store for the on/off toggle -- the More-menu
 *     checkbox reads it via `useSpotlightEnabled`, mirroring show-completed.
 *     It's a per-browser view preference, not synced document data.
 *  2. A tiny engine that toggles two `<body>` classes: `spotlight-on` (the mode)
 *     and `spotlight-fade` (the input modality). ALL of the dim/light logic is
 *     pure CSS (`:has(.node-text:focus)` + `:focus-within`, see styles.css) --
 *     no focus listeners, no generated stylesheet, no tree walk. Single-node
 *     lighting is exactly what `:focus-within` expresses, and "dim only while a
 *     caret is in the outline" is exactly `:has(:focus)`, so CSS does both.
 */

import { SPOTLIGHT_KEY } from "../lib/storage-keys";

// -- toggle store -----------------------------------------------------------

const listeners = new Set<() => void>();

export function subscribeSpotlight(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SPOTLIGHT_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSpotlightSnapshot(): boolean {
  try {
    return window.localStorage.getItem(SPOTLIGHT_KEY) === "true";
  } catch {
    return false;
  }
}

/** SPA/prerender has no window; spotlight is off during any server pass. */
export function getSpotlightServerSnapshot(): boolean {
  return false;
}

export function setSpotlightEnabled(next: boolean): void {
  try {
    window.localStorage.setItem(SPOTLIGHT_KEY, String(next));
  } catch {
    // localStorage can throw (private mode); the engine still toggles below.
  }
  for (const l of listeners) l();
}

// -- DOM engine -------------------------------------------------------------

const SPOTLIGHT_ON = "spotlight-on";
const SPOTLIGHT_FADE = "spotlight-fade";

let installed = false;

// The dim change eases on a pointer-driven focus and snaps on keyboard nav
// (ADR 0033): a click into a distant bullet can afford a fade, but rapid
// arrow-stepping must feel immediate. We only track the modality; CSS reacts.
const onPointerDown = () => document.body.classList.add(SPOTLIGHT_FADE);
const onKeyDown = () => document.body.classList.remove(SPOTLIGHT_FADE);

export function installSpotlight(): void {
  if (installed) return;
  installed = true;
  document.body.classList.add(SPOTLIGHT_ON);
  // Capture phase so the modality is set before focus lands.
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
}

export function uninstallSpotlight(): void {
  if (!installed) return;
  installed = false;
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKeyDown, true);
  document.body.classList.remove(SPOTLIGHT_ON, SPOTLIGHT_FADE);
}
