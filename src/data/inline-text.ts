// Flatten inline markup to its plain reading text -- the projection used for
// fuzzy search and for display-only strings (switcher titles, breadcrumb
// crumbs, mirror-place labels) where raw markdown would read as noise.
//
// A single funnel so the consumers can't drift, composed to MIRROR the editor's
// own token precedence (links 0 < date 6 < code 10 < emphasis 30 < highlight 35
// < spoiler 40, ADR 0025) -- search/display must read a run exactly as the
// editor draws it:
//
//   1. Dates + links flatten across the WHOLE string first (they outrank code):
//      `[[2026-07-08]]` -> its label, `[label](url)` -> `label`.
//   2. Code runs then SHIELD their interior (`stripCodeShielded`): the emphasis,
//      highlight and spoiler strips run over the text with every code interior
//      masked out, so a code chip reading `` `**x**` `` flattens to `**x**`, NOT
//      `x`. An emphasis run WRAPPING code is still stripped (`` **`code`** `` ->
//      `code`) -- only interiors are masked, not the markers around them.
//      Spoilers drop their fences but KEEP their interior (your own search must
//      see inside your own spoilers, ADR 0043; the MCP boundary REDACTS instead,
//      in the Worker).
//
// All halves are pure and side-effect-free (this module is imported by
// worker-reachable paths -- no DOM types).

import { stripCodeShielded } from "./code";
import { flattenDateLinks } from "./date-links";
import { stripEmphasis } from "./emphasis";
import { stripHighlights } from "./highlight";
import { stripLinks } from "./links";
import { stripSpoilers } from "./spoiler";

/** The strips a code run shields: highlight fences + color emoji, emphasis
 *  markers, spoiler fences (interior kept). Run over the code-masked text. */
function stripMarkup(text: string): string {
  return stripSpoilers(stripEmphasis(stripHighlights(text)));
}

/** Plain reading text of `text`: `[[2026-07-08]]` -> its display label
 *  ("Today"/"Jul 8" -- ADR 0038), `[label](url)` -> `label`, `==🔴x==` -> `x`,
 *  `*x*`/`**x**`/`~~x~~`/`~x~` -> `x`, `` `x` `` -> `x`, `||x||` -> `x`
 *  (in-app: interior kept). A code run keeps its interior VERBATIM, so
 *  `` `**x**` `` -> `**x**` and `` `~~s~~` `` -> `~~s~~` (the code chip shields
 *  the markers -- see the module header). Markup-free text passes through
 *  untouched. */
export function flattenInline(text: string): string {
  return stripCodeShielded(stripLinks(flattenDateLinks(text)), stripMarkup);
}
