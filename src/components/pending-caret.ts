// A pending caret OFFSET, keyed by the row it belongs to (ADR 0044).
//
// `pendingFocus` + `pendingFocusAtStart` cover the only two places a structural
// edit ever wanted the caret: the start or the end of the text. A markdown paste
// wants a third -- the SEAM, where the pasted tail welded back onto the last
// inserted bullet, which is neither. Rather than thread a third ref through
// every row, the offset rides a module singleton the two claim sites already
// pass through (the `flash-node.ts` shape). It is one-shot: whoever focuses the
// row consumes it, and a stale offset can never leak onto a later focus.

import { placeCaretAtEnd, placeCaretAtStart } from "./caret-place";
import { setCaretOffset } from "./inline-code";

let pending: { key: string; offset: number } | null = null;

/** Queue a source-space caret offset for the row `key` about to take focus. */
export function setPendingCaretOffset(key: string, offset: number): void {
  pending = { key, offset };
}

export function clearPendingCaretOffset(): void {
  pending = null;
}

/**
 * Place the caret in a row that has just taken focus: at the queued seam offset
 * if one was set for it, else the usual start/end. The single funnel for both
 * claim sites (the editor's `FocusPass` and a windowed row's mount effect).
 */
export function applyPendingCaret(el: HTMLElement, key: string, atStart: boolean): void {
  if (pending && pending.key === key) {
    const { offset } = pending;
    pending = null;
    setCaretOffset(el, offset);
    return;
  }
  if (atStart) placeCaretAtStart(el);
  else placeCaretAtEnd(el);
}
