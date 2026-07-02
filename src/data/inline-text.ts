// Flatten inline markup to its plain reading text -- the projection used for
// fuzzy search and for display-only strings (switcher titles, breadcrumb
// crumbs, mirror-place labels) where raw markdown would read as noise.
//
// A single funnel so the two consumers (node-switcher, mirror-places) can't
// drift: a link folds to its label (`stripLinks`), then emphasis runs drop
// their markers (`stripEmphasis`). Both halves are pure and side-effect-free.

import { stripEmphasis } from "./emphasis";
import { stripLinks } from "./links";

/** Plain reading text of `text`: `[label](url)` -> `label`, `*x*`/`**x**`/
 *  `~~x~~`/`~x~` -> `x`. Emphasis-free, link-free text passes through
 *  untouched. Links flatten first so an emphasized link label still reduces
 *  cleanly. */
export function flattenInline(text: string): string {
  return stripEmphasis(stripLinks(text));
}
