let opener: (() => void) | null = null;

export function setChangelogOpener(fn: typeof opener) {
  opener = fn;
}

/**
 * Open the "What's new" dialog from anywhere — the header badge, the More menu,
 * and the Cmd+K command center all call this (ADR 0034: one action, several
 * surfaces). The dialog itself is mounted once in `__root.tsx`
 * (`ChangelogDialog`), which registers the opener.
 */
export function openChangelog() {
  opener?.();
}
