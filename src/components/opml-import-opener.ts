let opener: (() => void) | null = null;

export function setOpmlImportOpener(fn: typeof opener) {
  opener = fn;
}

/**
 * Kick off the OPML import flow (hidden file picker -> summary dialog) from
 * anywhere — the header More menu and the Cmd+K command center both call this
 * (ADR 0034: one action, several surfaces). The dialog itself is mounted once
 * in `__root.tsx` (`OpmlImportDialog`), which registers the opener.
 */
export function openOpmlImport() {
  opener?.();
}
