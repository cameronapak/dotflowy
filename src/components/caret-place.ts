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
