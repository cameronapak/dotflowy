// The inline-code run -- `` `like this` `` -- as pure grammar, so display-only
// surfaces can flatten it without importing the code plugin's DOM-bound render
// (the `emphasis.ts` / `highlight.ts` / `spoiler.ts` split: the pattern lives
// here, the plugin dresses it).

/** Single-line, non-empty, no nested backtick -- the same run the code plugin
 *  tokenizes (`src/plugins/code/index.ts`). Kept in parity by hand, like the
 *  other strip patterns; the plugin owns precedence, this owns the shape. */
const CODE_RUN_PATTERN = "`[^`\\n]+`";

/** Built per-call, never a module singleton: a `g`-flagged RegExp carries
 *  `lastIndex` across calls, so a shared instance would skip back-to-back runs
 *  (the `emphasis.ts` rule). */
function codeRunRegex(): RegExp {
  return new RegExp(CODE_RUN_PATTERN, "g");
}

/** The interior of every inline-code run, in place -- backticks dropped, the
 *  rest kept verbatim. The `stripEmphasis` projection for code spans.
 *
 *  Guarded on the marker char first: `flattenInline` runs per node while the
 *  `[[` picker scans, and backtick-free text is the overwhelming majority, so
 *  the regex is never even constructed for it (mirrors `stripEmphasis`). */
export function stripCode(text: string): string {
  if (!text.includes("`")) return text;
  return text.replace(codeRunRegex(), (run) => run.slice(1, -1));
}
