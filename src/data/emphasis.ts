// Pure emphasis layer for inline formatting (italics, bold, strikethrough,
// underline -- ADR 0025). Like a `code` run or a `#tag`, an emphasis run lives
// literally in `node.text`: `*italic*`, `**bold**`, `~~strike~~`, `~underline~`
// (Bear-style). The emphasis plugin (src/plugins/emphasis) decorates the same
// runs as a token with the EDGED shape (interior editable, markers hidden via
// data attrs until the caret touches an edge -- the links reveal feel).
//
// This module is DOM-free and side-effect-free. The DOM half (edged caret
// remap on reveal) lives in inline-code.ts; the slash/keyboard entry lives in
// the emphasis plugin.
//
// v1 is FLAT: no nesting, no `***bold+italic***`, no `_underscore_` variants.
// A run that doesn't cleanly match one of the four patterns renders as literal
// text. See ADR 0025.

// Each run is `<markers><non-empty interior></markers>` on a single line. The
// interior forbids the marker char itself (so `*a*b` matches the italic run
// `a`, but `*a*b*c*` is two runs, not nested). The double-char markers (`**`,
// `~~`) are listed BEFORE their single-char siblings so the registry's
// lower-precedence-wins ordering resolves `**` before `*` on the same span
// (the combined regex alternation tries earlier branches first).

/** Bold: `**x**` -- interior has no literal `*`. */
export const BOLD_PATTERN = "\\*\\*[^*\\n]+\\*\\*";
/** Italic: `*x*` -- interior has no literal `*`. */
export const ITALIC_PATTERN = "\\*[^*\\n]+\\*";
/** Strikethrough: `~~x~~` (GFM) -- interior has no literal `~`. */
export const STRIKETHROUGH_PATTERN = "~~[^~\\n]+~~";
/** Underline: `~x~` (Bear-style, non-standard but portable within dotflowy) --
 *  interior has no literal `~`. Shares its leading char with strikethrough, so
 *  strikethrough must take precedence (lower precedence value wins). */
export const UNDERLINE_PATTERN = "~[^~\\n]+~";

/** The four patterns as one alternation, in precedence order. Used by
 *  `stripEmphasis` and `hasEmphasis` -- the registry composes its own combined
 *  regex from the plugin's tokens (with per-token named groups for dispatch),
 *  so this is only for the pure-logic consumers that don't need to know which
 *  kind of run matched.
 *
 *  Built per-call (not a module singleton): a `g`-flagged RegExp carries
 *  `lastIndex` across `.test()` calls, so a shared instance would miss
 *  back-to-back matches. Mirrors `tags.ts`'s pattern. */
function anyEmphasisRegex(): RegExp {
  return new RegExp(
    [BOLD_PATTERN, STRIKETHROUGH_PATTERN, ITALIC_PATTERN, UNDERLINE_PATTERN]
      .join("|"),
    "gu",
  );
}

/** True iff the text contains at least one complete emphasis run. */
export function hasEmphasis(text: string): boolean {
  return anyEmphasisRegex().test(text);
}

/** The interior text of every emphasis run, concatenated in place -- the
 *  projection used for fuzzy search (matches `stripLinks`, which flattens a
 *  link to its label). Markers are stripped; the rest of the text is kept
 *  verbatim. A run with empty interior can't match (the patterns require a
 *  non-empty interior), so there's nothing to collapse. */
export function stripEmphasis(text: string): string {
  return text.replace(anyEmphasisRegex(), (run) => {
    // Every pattern uses the SAME marker char on both edges with equal length
    // (1 for italic/underline, 2 for bold/strike). Count the leading run of
    // that char to get the marker length, then slice the interior out.
    const markerLen = emphasisMarkerLen(run);
    if (markerLen === 0) return run; // defensive -- patterns always match
    return run.slice(markerLen, run.length - markerLen);
  });
}

/** The opening+closing marker length for a matched run. Bold/strike use 2,
 *  italic/underline use 1. Returns 0 for an unrecognized run (defensive -- the
 *  patterns are fixed, so this never fires for a real match). Used by the
 *  plugin to stamp `data-edge-len-pre`/`data-edge-len-post` without recomputing
 *  the marker char. */
export function emphasisMarkerLen(run: string): number {
  // The opening marker is a run of identical chars at the start; the patterns
  // guarantee the closing marker has the same length. Count the leading run.
  const ch = run[0];
  if (ch !== "*" && ch !== "~") return 0;
  let n = 0;
  while (n < run.length && run[n] === ch) n++;
  return n;
}
