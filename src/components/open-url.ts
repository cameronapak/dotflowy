export function openUrlInFocusedTab(
  url: string,
  options: { restoreFocus?: () => void } = {},
): void {
  if (options.restoreFocus) restoreOnReturn(options.restoreFocus);
  const tab = window.open(url, "_blank");
  tab?.focus();
  try {
    if (tab) tab.opener = null;
  } catch {
    // Some browsers disallow mutating opener; the tab has already opened.
  }
}

function restoreOnReturn(restoreFocus: () => void): void {
  const restore = () => {
    cleanup();
    requestAnimationFrame(restoreFocus);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") restore();
  };
  const cleanup = () => {
    window.removeEventListener("focus", restore);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  window.addEventListener("focus", restore);
  document.addEventListener("visibilitychange", onVisibilityChange);
}
