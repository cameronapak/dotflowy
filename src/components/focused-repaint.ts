/**
 * Whether the store-sync effect must leave a focused editor's DOM alone
 * (ADR 0010). While an editor is focused its `contentEditable` owns the text
 * and the caret; a repaint from stored text is right only when that text is
 * news to the DOM, such as an undo or a slash insert.
 */
export function keepsFocusedDom({
  rendered,
  live,
  echoed,
  heldDom,
}: {
  /** The text of the render this effect belongs to. */
  rendered: string;
  /** The text the store holds now, or undefined for a node it does not hold. */
  live: string | undefined;
  /** The last text the sync channel echoed for this node. */
  echoed: string | undefined;
  /** The DOM's text when the editor holds a typed-ahead prefix (titles), else null. */
  heldDom: string | null;
}): boolean {
  // A keystroke landed between this render's commit and its effect. The DOM
  // and the store both hold the newer text, and the next render is on its way.
  // Painting this render's text would drop the keystroke from the DOM and
  // leave the caret one place back, so every later character lands before it.
  if (live !== undefined && live !== rendered) return true;
  // The network reflecting this editor's own keystrokes back.
  if (echoed === rendered) return true;
  if (
    heldDom !== null &&
    heldDom !== rendered &&
    heldDom.startsWith(rendered)
  ) {
    return true;
  }
  return false;
}
