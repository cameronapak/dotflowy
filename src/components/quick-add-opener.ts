let opener: (() => void) | null = null;

export function setQuickAddOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the quick-add capture overlay from anywhere (Opt+Cmd+N, the Cmd+K
 *  action, the mobile FAB). No-op until the overlay mounts. See ADR 0049. */
export function openQuickAdd() {
  opener?.();
}
