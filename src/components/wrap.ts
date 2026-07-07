// Selection-wrap helpers for marker-fenced inline tokens (ADR 0025 / 0035 /
// 0036). The emphasis slash commands + keymap (`/bold`, Cmd+B, ...), the
// highlight plugin, and the desktop selection formatting toolbar all want to
// wrap the current SELECTION in a marker pair (or, with no selection, insert an
// empty pair). Everything operates in SOURCE space (readSource +
// getSelectionRange + setCaretOffset/setSelectionOffsets) so a folded link
// elsewhere on the line keeps its url; mirrors paste.ts's mechanics.
//
// Every call site fires while a bullet (or the zoomed title) is focused, so the
// contentEditable is `document.activeElement`. Resolving it from the editor's
// refs registry would require a new seam; reading the active element keeps the
// plugin contract unchanged. The PURE toggle math lives in data/inline-wrap.ts
// (unit-tested); this module is the thin DOM shell around it.

import {
  decorate,
  getSelectionRange,
  readSource,
  setCaretOffset,
  setSelectionOffsets,
} from "./inline-code";
import {
  detectMarkerWrap,
  type MarkerPair,
  planMarkerToggle,
} from "../data/inline-wrap";
import { parseHighlight } from "../data/highlight";

export { detectMarkerWrap };
export type { MarkerPair };

/** The focused contentEditable, or null when no bullet/title is focused. */
function activeEditable(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  return el && el.isContentEditable ? el : null;
}

/** The source string + selection offsets of the focused contentEditable, for
 *  the toolbar's active-state read (which markers already wrap the selection).
 *  Null when nothing is focused/selected. */
export function readActiveSelectionSource(): {
  source: string;
  start: number;
  end: number;
} | null {
  const el = activeEditable();
  if (!el) return null;
  const source = readSource(el);
  const range = getSelectionRange(el);
  if (!range) return null;
  return { source, start: range.start, end: range.end };
}

/** Wrap the selection (or insert an empty pair) inside the focused
 *  contentEditable, placing the caret just after the wrapped interior (or at the
 *  start of an empty pair). ADD-only -- pressing it twice double-wraps. Kept for
 *  the highlight plugin's keymap/slash, whose in-source color emoji makes a
 *  clean toggle-off the color menu's job. Returns false when nothing is focused. */
export function wrapSelectionOrInsert(
  nodeId: string,
  marker: MarkerPair,
  onTextChange: (id: string, text: string) => void,
): boolean {
  const el = activeEditable();
  if (!el) return false;

  const source = readSource(el);
  const range = getSelectionRange(el) ?? {
    start: source.length,
    end: source.length,
  };
  const { start, end } = range;
  const hasSelection = end > start;

  const interior = source.slice(start, end);
  const next =
    source.slice(0, start) +
    marker.pre +
    interior +
    marker.post +
    source.slice(end);

  const caret = hasSelection
    ? start + marker.pre.length + interior.length
    : start + marker.pre.length;

  onTextChange(nodeId, next);
  decorate(el, next, caret, false);
  setCaretOffset(el, caret);
  return true;
}

/** TOGGLE the marker over the current selection: unwrap if already wrapped,
 *  else wrap (an empty selection inserts an empty pair with the caret inside).
 *  Used by the emphasis keymap/slash and the selection toolbar.
 *
 *  `reselect` decides the resting caret after a wrap:
 *  - `false` (keymap/slash): collapse just past the interior — byte-identical to
 *    the old add-only behavior for a fresh selection, so the keyboard path is
 *    unchanged (and leaves no lingering range).
 *  - `true` (toolbar): re-select the interior, so a re-press toggles straight
 *    back off and the toolbar button stays lit.
 *
 *  Returns false when nothing is focused. */
export function toggleWrapSelection(
  nodeId: string,
  marker: MarkerPair,
  onTextChange: (id: string, text: string) => void,
  reselect = false,
): boolean {
  const el = activeEditable();
  if (!el) return false;

  const source = readSource(el);
  const range = getSelectionRange(el) ?? {
    start: source.length,
    end: source.length,
  };
  const plan = planMarkerToggle(source, range.start, range.end, marker);

  onTextChange(nodeId, plan.next);
  // revealOffset = the affected run's end, so it reveals (real, selectable text)
  // instead of folding into an atom under the caret/selection.
  decorate(el, plan.next, plan.range.end, false);
  if (reselect && plan.range.start !== plan.range.end)
    setSelectionOffsets(el, plan.range.start, plan.range.end);
  else setCaretOffset(el, plan.range.end);
  return true;
}

/** TOGGLE a highlight over the selection. A whole `==run==` selected (typically
 *  a folded highlight atom) is stripped back to its interior WITH its color
 *  emoji removed (via parseHighlight); anything else is wrapped in the bare,
 *  default-blue `==` fence (recolor stays the right-click menu). The toolbar's
 *  one highlight button; emphasis's clean marker toggle can't own this because
 *  the color emoji rides inside the source (ADR 0035). Returns false when
 *  nothing is focused. */
export function toggleHighlightSelection(
  nodeId: string,
  onTextChange: (id: string, text: string) => void,
): boolean {
  const el = activeEditable();
  if (!el) return false;

  const source = readSource(el);
  const range = getSelectionRange(el) ?? {
    start: source.length,
    end: source.length,
  };
  const { start, end } = range;
  const sel = source.slice(start, end);

  // Already a highlight run selected whole -> strip fences + color emoji.
  if (sel.length > 4 && sel.startsWith("==") && sel.endsWith("==")) {
    const inner = parseHighlight(sel).interior;
    const next = source.slice(0, start) + inner + source.slice(end);
    onTextChange(nodeId, next);
    decorate(el, next, start + inner.length, false);
    setSelectionOffsets(el, start, start + inner.length);
    return true;
  }

  // Otherwise wrap in the bare (default-blue) fence.
  const next = source.slice(0, start) + "==" + sel + "==" + source.slice(end);
  const innerStart = start + 2;
  onTextChange(nodeId, next);
  decorate(el, next, innerStart + sel.length, false);
  if (sel.length === 0) setCaretOffset(el, innerStart);
  else setSelectionOffsets(el, innerStart, innerStart + sel.length);
  return true;
}
