let opener: (() => void) | null = null;

export function setAppleShortcutOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the focused setup dialog from Settings > Experimental. */
export function openAppleShortcut() {
  opener?.();
}
