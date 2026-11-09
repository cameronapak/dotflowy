/** The active editor's zoom action, shared with the owner-only feedback gate.
 * A WeakMap keeps mirror resolution and menu gating in the bullet keymap. */
export const nodeZoomShortcuts = new WeakMap<HTMLElement, () => void>();

/** Registered before Amp's window-capture listener, which otherwise consumes
 * Mod+. before the focused editor can receive it. Other shortcuts pass through. */
export function captureNodeZoomShortcut(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.key !== "." ||
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    !(event.target instanceof HTMLElement) ||
    event.target !== document.activeElement
  )
    return;
  const zoom = nodeZoomShortcuts.get(event.target);
  if (!zoom) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  zoom();
}
