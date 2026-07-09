// Pure spoiler layer (ADR 0043). A spoiler lives literally in `node.text` as
// `||interior||` -- Discord/Telegram's inline-spoiler markup and the de facto
// standard -- so a spoiler pasted into Discord is a spoiler, and one pasted out
// of dotflowy stays self-describing (the ADR 0035 "portable when pasted"
// principle). No schema field, no migration: a spoiler is text.
//
// It is the first token whose meaning is AUDIENCE-DEPENDENT, so this module
// exports TWO opposite operations on the same run:
//
//   - stripSpoilers(text)   -> fences off, interior KEPT. The in-app flatten
//                              projection (flattenInline: Cmd+K corpus,
//                              breadcrumbs, in-app search). Your own search must
//                              find text inside your own spoilers.
//   - redactSpoilers(text)  -> the whole run collapses to the fixed sentinel
//                              `[spoiler]`, interior GONE. Applied at every MCP
//                              egress (worker/outline-ops.ts). The interior
//                              never crosses the LLM boundary, and search that
//                              redacts BEFORE matching cannot even confirm a
//                              term lives inside a spoiler (zero hits, not
//                              masked hits).
//
// This is a CONTEXT-HYGIENE default, not access control: the MCP agent holds
// the user's own keys and can drop the fences itself. Redaction keeps flagged
// text out of an LLM's context window by default -- see ADR 0043.
//
// This module is DOM-free and side-effect-free (the `highlight.ts` /
// `date-links.ts` shape, `bun test`-clean), imported by the Worker via the
// cross-tsconfig pattern (ADR 0014) so client and Worker can't drift. The
// decoration half lives in src/plugins/spoiler.

/** Spoiler: `||x||` -- interior is non-empty and has no literal `|`, mirroring
 *  the emphasis double-char patterns' liberal shape (`a || b || c` matches
 *  `|| b ||`, the same over-match `**`/`==` already accept). `|` shares a
 *  leading char with no other token, so this slots in at precedence 40 (after
 *  highlight's 35) with no double-vs-single coupling to order around. */
export const SPOILER_PATTERN = "\\|\\|[^|\\n]+\\|\\|";

/** Marker length on each side (`||`). */
const MARKER_LEN = 2;

/** The fixed redaction sentinel. Interior-length-independent on purpose -- the
 *  character count is itself a leak (don't hand the agent "a 7-letter spoiler").
 *  A visible marker (vs silent omission) lets the agent be useful about it
 *  ("there's a spoiler here I can't read") and stops it hallucinating across a
 *  gap. See ADR 0043. */
export const SPOILER_SENTINEL = "[spoiler]";

/** Built per call: a `g`-flagged RegExp carries `lastIndex` across `.test()`
 *  calls, so a shared instance would miss back-to-back matches (mirrors
 *  highlight.ts / emphasis.ts). */
function spoilerRegex(): RegExp {
  return new RegExp(SPOILER_PATTERN, "gu");
}

/** True iff the text contains at least one complete spoiler run. */
export function hasSpoiler(text: string): boolean {
  return spoilerRegex().test(text);
}

/** The visible text between the fences of a single matched run. */
export function spoilerInterior(run: string): string {
  return run.slice(MARKER_LEN, run.length - MARKER_LEN);
}

/** The source run for `interior`. */
export function buildSpoiler(interior: string): string {
  return `||${interior}||`;
}

/** In-app projection: every spoiler run replaced by its interior (fences off,
 *  interior kept) -- the `stripHighlights` sibling that `flattenInline` chains.
 *  Bails before building the regex when `text` has no `|` (the parallel guard
 *  in stripLinks/stripHighlights -- flattenInline runs this per scanned node). */
export function stripSpoilers(text: string): string {
  if (!text.includes("|")) return text;
  return text.replace(spoilerRegex(), (run) => spoilerInterior(run));
}

/** MCP-egress projection: every spoiler run replaced by the `[spoiler]`
 *  sentinel (interior gone). The OPPOSITE of stripSpoilers -- do NOT reuse one
 *  for the other. Applied to EVERY text value the MCP server emits (node text,
 *  search snippets, ancestor path/breadcrumb trails). Same `|`-guard fast path. */
export function redactSpoilers(text: string): string {
  if (!text.includes("|")) return text;
  return text.replace(spoilerRegex(), SPOILER_SENTINEL);
}
