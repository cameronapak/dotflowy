export function openUrlInFocusedTab(
  url: string,
  options: { restoreFocus?: () => void } = {},
): void {
  const tab = window.open(url, "_blank");
  if (!tab) return; // popup blocked -- nothing opened, nothing to restore
  if (options.restoreFocus) restoreOnReturn(options.restoreFocus);
  tab.focus();
  try {
    tab.opener = null;
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
  // If the browser kept the new tab in the background this window never
  // blurs, so the armed restore would fire on some much-later focus event and
  // yank the caret. Any local interaction means the user stayed -- disarm.
  // Capture phase: listeners added mid-dispatch can't catch the very keydown/
  // click that triggered the open (window's capture pass already ran).
  const disarm = () => cleanup();
  const cleanup = () => {
    window.removeEventListener("focus", restore);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pointerdown", disarm, true);
    window.removeEventListener("keydown", disarm, true);
  };
  window.addEventListener("focus", restore);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pointerdown", disarm, true);
  window.addEventListener("keydown", disarm, true);
}
