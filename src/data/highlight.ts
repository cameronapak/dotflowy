// Pure highlight layer (ADR 0035). A highlight lives literally in `node.text`
// as `==interior==` -- the de facto markdown highlight markup (Bear, Obsidian,
// Typora) -- so copying a highlighted line pastes as a highlight elsewhere.
//
// COLOR is encoded IN the source, Lettera-style: an optional leading circle
// emoji names the color (`==🔴urgent==` is a red highlight). The emoji is
// hidden while the run is folded and shown as real walk-through text on
// reveal. This is deliberately NOT a side-collection like tag colors: a tag's
// color is keyed by NAME (one choice, every instance), but a highlight has no
// name -- each run owns its color, and carrying it in the text keeps the
// markdown self-describing when pasted into another app (the visible dot IS
// the color). See ADR 0035.
//
// The palette is the six tag colors that have a circle emoji; a bare run
// defaults to blue. Color NAMES intentionally match `TAG_COLORS` so the plugin
// paints with the same `--tag-*` CSS variables -- but this module stays
// dependency-free (no tag-colors import: that file drags in the collection
// stack, and this one must stay pure for `bun test`).
//
// This module is DOM-free and side-effect-free; the decoration half lives in
// src/plugins/highlight.

export type HighlightColor =
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "blue"
  | "purple";

/** Emoji -> color, in palette order. Every emoji is a SINGLE code point, so
 *  the combined `gu` token regex can hold them in one character class. */
export const HIGHLIGHT_EMOJI: ReadonlyArray<{
  emoji: string;
  color: HighlightColor;
}> = [
  { emoji: "🔴", color: "red" },
  { emoji: "🟠", color: "orange" },
  { emoji: "🟡", color: "amber" },
  { emoji: "🟢", color: "green" },
  { emoji: "🔵", color: "blue" },
  { emoji: "🟣", color: "purple" },
];

/** A bare `==run==` is blue (Cam's call -- see ADR 0035), so the common case
 *  needs no emoji and stays the cleanest possible markdown. */
export const HIGHLIGHT_DEFAULT_COLOR: HighlightColor = "blue";

const EMOJI_CLASS = HIGHLIGHT_EMOJI.map((e) => e.emoji).join("");

/** Highlight: `==x==`, optionally `==<emoji>x==` -- interior has no literal
 *  `=`, mirroring the emphasis patterns' liberal shape (`a == b == c` matches
 *  `== b ==`, same class of over-match `**` already accepts). The emoji class
 *  is optional and greedy, so a colored run binds its emoji to the color slot;
 *  an emoji-ONLY run (`==🔵==`) backtracks into a default-color highlight OF
 *  the emoji. */
export const HIGHLIGHT_PATTERN = `==[${EMOJI_CLASS}]?[^=\\n]+==`;

/** Built per call: a `g`-flagged RegExp carries `lastIndex` across `.test()`
 *  calls, so a shared instance would miss back-to-back matches (mirrors
 *  tags.ts / emphasis.ts). */
function highlightRegex(): RegExp {
  return new RegExp(HIGHLIGHT_PATTERN, "gu");
}

/** True iff the text contains at least one complete highlight run. */
export function hasHighlight(text: string): boolean {
  return highlightRegex().test(text);
}

export interface HighlightParts {
  color: HighlightColor;
  /** The color emoji, or null for a bare (default-color) run. */
  emoji: string | null;
  /** The visible text between the fences, emoji excluded. */
  interior: string;
}

/** Split a matched run into color + interior. Mirrors the regex's backtracking:
 *  a leading emoji counts as the color slot only when something follows it
 *  (`==🔵==` is a default-color highlight of "🔵", exactly what the pattern
 *  matched). */
export function parseHighlight(run: string): HighlightParts {
  const inner = run.slice(2, -2);
  for (const { emoji, color } of HIGHLIGHT_EMOJI) {
    if (inner.startsWith(emoji) && inner.length > emoji.length) {
      return { color, emoji, interior: inner.slice(emoji.length) };
    }
  }
  return { color: HIGHLIGHT_DEFAULT_COLOR, emoji: null, interior: inner };
}

/** The source run for `interior` in `color`. The default color emits the BARE
 *  form (no emoji) -- the cleanest markdown wins wherever it can. */
export function buildHighlightRun(
  color: HighlightColor,
  interior: string,
): string {
  if (color === HIGHLIGHT_DEFAULT_COLOR) return `==${interior}==`;
  const emoji = HIGHLIGHT_EMOJI.find((e) => e.color === color)?.emoji ?? "";
  return `==${emoji}${interior}==`;
}

/** The interior text of every highlight run, fences + color emoji stripped --
 *  the search/display projection (the `stripEmphasis` sibling). */
export function stripHighlights(text: string): string {
  return text.replace(highlightRegex(), (run) => parseHighlight(run).interior);
}

/** Replace the FIRST occurrence of `oldRun` with `newRun`, or null when the
 *  text no longer contains it -- verbatim-match-or-drop, the same recolor
 *  contract as `replaceLinkToken` (a stale token drops the edit instead of
 *  corrupting the line). */
export function spliceHighlightRun(
  text: string,
  oldRun: string,
  newRun: string,
): string | null {
  const at = text.indexOf(oldRun);
  if (at < 0) return null;
  return text.slice(0, at) + newRun + text.slice(at + oldRun.length);
}
