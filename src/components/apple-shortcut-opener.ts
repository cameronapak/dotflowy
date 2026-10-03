let opener: (() => void) | null = null;

export function setAppleShortcutOpener(fn: typeof opener) {
  opener = fn;
}

/** The same focused setup dialog serves Settings and the header More menu. */
export function openAppleShortcut() {
  opener?.();
}
