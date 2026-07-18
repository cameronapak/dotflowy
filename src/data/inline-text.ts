// Flatten inline markup to its plain reading text -- the projection used for
// fuzzy search and for display-only strings (switcher titles, breadcrumb
// crumbs, mirror-place labels) where raw markdown would read as noise.
//
// A single funnel so the two consumers (node-switcher, mirror-places) can't
// drift: a link folds to its label (`stripLinks`), then highlight runs drop
// their fences + color emoji (`stripHighlights`), then emphasis runs drop
// their markers (`stripEmphasis`), then spoiler runs drop their fences but KEEP
// their interior (`stripSpoilers` -- your own search must see inside your own
// spoilers, ADR 0043; the MCP boundary REDACTS instead, in the Worker). All
// halves are pure and side-effect-free.

import { stripCode } from "./code";
import { flattenDateLinks } from "./date-links";
import { stripEmphasis } from "./emphasis";
import { stripHighlights } from "./highlight";
import { stripLinks } from "./links";
import { stripSpoilers } from "./spoiler";

/** Plain reading text of `text`: `[[2026-07-08]]` -> its display label
 *  ("Today"/"Jul 8" -- ADR 0038), `[label](url)` -> `label`, `==🔴x==` -> `x`,
 *  `*x*`/`**x**`/`~~x~~`/`~x~` -> `x`, `` `x` `` -> `x`, `||x||` -> `x`
 *  (in-app: interior kept). Markup-free text passes through untouched. Dates
 *  and links flatten first so an emphasized or highlighted label still reduces
 *  cleanly; `stripCode` runs LAST so a run that only becomes backtick-delimited
 *  after an outer marker is dropped still reduces. */
export function flattenInline(text: string): string {
  return stripCode(
    stripSpoilers(
      stripEmphasis(stripHighlights(stripLinks(flattenDateLinks(text)))),
    ),
  );
}
