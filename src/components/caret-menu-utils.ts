import { getCaretOffset } from "./inline-code";

export function wrap(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

/** SOURCE-character offset before the collapsed caret within `el`, or null when
 *  there's no collapsed selection inside it. Source-aware (folded links count
 *  their full markdown), so detect/select below slice readSource consistently. */
export function caretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  if (!el.contains(sel.getRangeAt(0).endContainer)) return null;
  return getCaretOffset(el);
}

/** Viewport coords of the caret, falling back to the element's box. */
export function caretPosition(el: HTMLElement): { x: number; y: number } {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (rect.left || rect.top || rect.height) {
      return { x: rect.left, y: rect.bottom };
    }
  }
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}
