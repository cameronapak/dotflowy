// Flatten inline markup to its plain reading text -- the projection used for
// fuzzy search and for display-only strings (switcher titles, breadcrumb
// crumbs, mirror-place labels) where raw markdown would read as noise.
//
// A single funnel so the two consumers (node-switcher, mirror-places) can't
// drift: a link folds to its label (`stripLinks`), then highlight runs drop
// their fences + color emoji (`stripHighlights`), then emphasis runs drop
// their markers (`stripEmphasis`). All halves are pure and side-effect-free.

import { flattenDateLinks } from "./date-links";
import { stripEmphasis } from "./emphasis";
import { stripHighlights } from "./highlight";
import { stripLinks } from "./links";

/** Plain reading text of `text`: `[[2026-07-08]]` -> its display label
 *  ("Today"/"Jul 8" -- ADR 0038), `[label](url)` -> `label`, `==🔴x==` -> `x`,
 *  `*x*`/`**x**`/`~~x~~`/`~x~` -> `x`. Markup-free text passes through
 *  untouched. Dates and links flatten first so an emphasized or highlighted
 *  label still reduces cleanly. */
export function flattenInline(text: string): string {
  return stripEmphasis(stripHighlights(stripLinks(flattenDateLinks(text))));
}
