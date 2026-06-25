export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function placeCaretAtStart(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// Cross-node caret nav preserves the column: drop the caret at the same
// viewport x the user left at, on the line nearest the side they're entering
// from (top line coming down, bottom line coming up). The browser already laid
// the text out, so we ask it which character sits under that point via
// caretPositionFromPoint -- no text-measurement library needed. See ADR 0008.
export function placeCaretAtColumn(
  el: HTMLElement,
  direction: "up" | "down",
  x: number,
) {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  // Aim at the vertical middle of the first (down) or last (up) visual line.
  const y =
    direction === "down" ? rect.top + lineH / 2 : rect.bottom - lineH / 2;
  // Keep the probe inside the element so it can't hit a neighbor.
  const clampedX = Math.max(rect.left + 1, Math.min(x, rect.right - 1));

  const hit = caretFromPoint(clampedX, y);
  if (hit && el.contains(hit.node)) {
    const range = document.createRange();
    range.setStart(hit.node, hit.offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return;
  }
  // Probe missed the text (empty bullet, x past the line end): fall back to the
  // edge we entered from.
  if (direction === "down") placeCaretAtStart(el);
  else placeCaretAtEnd(el);
}

// Standard API with a WebKit (caretRangeFromPoint) fallback. Coordinates are
// viewport-relative, matching getBoundingClientRect.
function caretFromPoint(
  x: number,
  y: number,
): { node: Range["startContainer"]; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const legacy = (
    document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint;
  if (legacy) {
    const range = legacy.call(document, x, y);
    return range
      ? { node: range.startContainer, offset: range.startOffset }
      : null;
  }
  return null;
}
