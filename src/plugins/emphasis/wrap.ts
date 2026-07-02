// Emphasis entry helpers (ADR 0025). The slash commands (`/bold`, `/italic`,
// `/underline`, `/strikethrough`) and the per-bullet keymap (Cmd+B / Cmd+I /
// Cmd+U / Cmd+Shift+X) both want the same behavior: wrap the current SELECTION
// in the marker pair, or -- with no selection -- insert an empty marker pair
// and place the caret inside it. Both operate in SOURCE space (readSource +
// getSelectionRange + setCaretOffset) so a folded link elsewhere on the line
// keeps its url; mirrors paste.ts's mechanics.
//
// Both call sites fire while a bullet (or the zoomed title) is focused, so the
// contentEditable is `document.activeElement`. Resolving it from the editor's
// refs registry would require a new seam; reading the active element keeps the
// plugin contract unchanged.

import {
  decorate,
  getSelectionRange,
  readSource,
  setCaretOffset,
} from "../../components/inline-code";

/** A marker pair for one of the four emphasis kinds. `pre`/`post` are always
 *  equal-length in v1 (italic `*`/`*`, bold `**`/`**`, strike `~~`/`~~`,
 *  underline `~`/`~`) but kept separate so a future asymmetry (rare) doesn't
 *  require an API change. */
export interface MarkerPair {
  pre: string;
  post: string;
}

/** The four marker pairs. Keys match the slash-command ids and the keymap
 *  wiring. Bold before strikethrough before italic before underline mirrors
 *  the registry precedence order -- not load-bearing here (the wrap doesn't
 *  re-parse), but consistent. */
export const MARKERS: Record<"bold" | "italic" | "underline" | "strike", MarkerPair> = {
  bold: { pre: "**", post: "**" },
  italic: { pre: "*", post: "*" },
  underline: { pre: "~", post: "~" },
  strike: { pre: "~~", post: "~~" },
};

/** Wrap the current selection (or insert an empty pair) inside the focused
 *  contentEditable. Writes the new source through `onTextChange`, re-decorates,
 *  and places the caret:
 *  - with a selection: just AFTER the wrapped interior (so the next keystroke
 *    types past the closing marker).
 *  - with no selection: at the start of the empty interior, ready to type.
 *
 *  `onTextChange` is the bullet's `ctx.mutations.onTextChange` -- a field edit,
 *  not a structural one (no echo-wait needed; the keystroke path must not
 *  await). See ADR 0009.
 *
 *  Returns true if it acted, false when no contentEditable is focused (no-op,
 *  so a stray keypress with nothing focused does nothing). */
export function wrapSelectionOrInsert(
  nodeId: string,
  kind: keyof typeof MARKERS,
  onTextChange: (id: string, text: string) => void,
): boolean {
  // The wrap fires only from a focused bullet/title keymap or a slash command,
  // so the active element IS the contentEditable we want to mutate.
  const el = document.activeElement as HTMLElement | null;
  if (!el || !el.isContentEditable) return false;

  const marker = MARKERS[kind];
  // SOURCE-space read so a folded link on the same line keeps its url.
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

  // Caret lands just past the wrapped interior (selection case) or at the
  // start of the empty interior (no-selection case).
  const caret = hasSelection
    ? start + marker.pre.length + interior.length
    : start + marker.pre.length;

  onTextChange(nodeId, next);
  decorate(el, next, caret, false);
  setCaretOffset(el, caret);
  return true;
}
