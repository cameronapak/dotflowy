/**
 * Collapse the caret to the start/end of a contentEditable's contents. Shared by
 * the editor's focus pass, cross-bullet caret motion, and the exit from node
 * multi-selection back to a caret -- one definition so they can't drift.
 */

export function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

export function placeCaretAtStart(el: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/**
 * Resolve a viewport point to a caret position. Standard API with a WebKit
 * (`caretRangeFromPoint`) fallback; coordinates are viewport-relative, matching
 * `getBoundingClientRect`. Shared by vertical caret motion (arrow up/down) and
 * the row dead-space tap-to-edit (ADR 0029).
 */
export function caretFromPoint(
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y)
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null
  }
  const legacy = (
    document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
  ).caretRangeFromPoint
  if (legacy) {
    const range = legacy.call(document, x, y)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }
  return null
}

/**
 * Focus a bullet's text span in response to a tap on the row's DEAD SPACE (the
 * empty band to the right of a short line or below a wrapped one), placing the
 * caret at the tapped point when it lands inside the span and at end-of-text
 * otherwise (ADR 0029). The caller guards `e.target === e.currentTarget` so this
 * only ever runs for genuine dead-space taps, never on the text/links/chips.
 */
export function focusTextFromRowTap(
  span: HTMLElement | null,
  x: number,
  y: number,
) {
  if (!span) return
  span.focus()
  const hit = caretFromPoint(x, y)
  if (hit && span.contains(hit.node)) {
    const range = document.createRange()
    range.setStart(hit.node, hit.offset)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  } else {
    placeCaretAtEnd(span)
  }
}
