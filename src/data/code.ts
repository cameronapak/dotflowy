// The inline-code run -- `` `like this` `` -- as pure grammar, so display-only
// surfaces can flatten it without importing the code plugin's DOM-bound render
// (the `emphasis.ts` / `highlight.ts` / `spoiler.ts` split: the pattern lives
// here, the plugin dresses it).

/** Single-line, non-empty, no nested backtick -- the run the code plugin
 *  tokenizes. The code plugin (`src/plugins/code/index.ts`) IMPORTS this as its
 *  token pattern, so the two can't drift -- the `emphasis.ts` precedent
 *  (`BOLD_PATTERN` et al.), where the pure layer owns the shape and the plugin
 *  owns precedence + render. */
export const CODE_RUN_PATTERN = "`[^`\\n]+`";

/** Built per-call, never a module singleton: a `g`-flagged RegExp carries
 *  `lastIndex` across calls, so a shared instance would skip back-to-back runs
 *  (the `emphasis.ts` rule). */
function codeRunRegex(): RegExp {
  return new RegExp(CODE_RUN_PATTERN, "g");
}

// A private-use-area char no token grammar (emphasis/highlight/spoiler) can
// match, so it survives `stripRest` untouched -- the mask that shields a code
// run's interior while the OTHER strips run over the text around it.
const CODE_SENTINEL = "\uE000";

/** Apply `stripRest` to `text` with every inline-code run's interior SHIELDED:
 *  the code plugin's precedence (code 10 beats emphasis 30 / highlight 35 /
 *  spoiler 40, ADR 0025) means a code span's interior is literal, so an emphasis
 *  marker inside a run must NOT be stripped -- `` `**x**` `` flattens to `**x**`,
 *  not `x`. An emphasis run that WRAPS a code run is still stripped, because only
 *  the interior is masked, not the markers around it (`` **`code`** `` -> `code`).
 *  Each run is replaced by a sentinel, `stripRest` runs over the masked text,
 *  then the interiors are restored verbatim (backticks dropped).
 *
 *  Guarded on the marker char first: `flattenInline` runs per node while the
 *  `[[` picker scans, and backtick-free text is the overwhelming majority, so
 *  the mask/restore is skipped for it entirely (mirrors `stripEmphasis`). */
export function stripCodeShielded(
  text: string,
  stripRest: (masked: string) => string,
): string {
  if (!text.includes("`")) return stripRest(text);
  const interiors: string[] = [];
  const masked = text.replace(codeRunRegex(), (run) => {
    interiors.push(run.slice(1, -1));
    return CODE_SENTINEL;
  });
  let i = 0;
  return stripRest(masked).replaceAll(
    CODE_SENTINEL,
    () => interiors[i++] ?? "",
  );
}

/** The interior of every inline-code run, in place -- backticks dropped, the
 *  rest kept verbatim; text outside runs untouched. The `stripEmphasis`
 *  projection for code spans, and `stripCodeShielded` with an identity `stripRest`
 *  pass. */
export function stripCode(text: string): string {
  return stripCodeShielded(text, (masked) => masked);
}
