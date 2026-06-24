// Route Bible plugin styles (ADR 0027 -- the plugin styles seam). The plugin
// ships its OWN CSS here instead of bleeding into core styles.css; the core
// mounts it once via <PluginStyles>. Namespaced by the `.bible-ref` prefix --
// colocation + no-bleed-by-convention, NOT Shadow-DOM isolation (impossible for
// an inline chip inside the editor's contentEditable, ADR 0027).
//
// RAW CSS only -- this string is not run through Tailwind, so the layout that
// used to be utility classes (`rounded-full px-1.5 ...`) is spelled out and the
// press-bounce is `transform` directly (no `@apply`). `display: inline-block` is
// load-bearing: a `transform` does nothing on an inline box, so the chip must be
// inline-block for the :active bounce to actually move.
//
// Both icons are SVG masks tinted to the chip's `currentColor` (so they follow
// the light/dark text color), defined as local custom properties so the
// pseudo-elements inherit them. Kept as ::before/::after pseudo-elements so they
// stay out of textContent and the non-folding chip's caret math stays 1:1.

const BOOK_ICON = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5L12 12.5M10 8.5H14M6.5 21H18.5C19.3284 21 20 20.3284 20 19.5V4.5C20 3.67157 19.3284 3 18.5 3H6.5C5.11929 3 4 4.11929 4 5.5V18.5M6.5 21C5.11929 21 4 19.8807 4 18.5M6.5 21C6.1717 21 5.84661 20.9353 5.54329 20.8097C5.23998 20.6841 4.96438 20.4999 4.73223 20.2678C4.50009 20.0356 4.31594 19.76 4.1903 19.4567C4.06466 19.1534 4 18.8283 4 18.5M4 18.5C4 18.1717 4.06466 17.8466 4.1903 17.5433C4.31594 17.24 4.50009 16.9644 4.73223 16.7322C4.96438 16.5001 5.23998 16.3159 5.54329 16.1903C5.84661 16.0647 6.1717 16 6.5 16L20 16"/></svg>')`;

// lucide `external-link` -- mirrors the rich-links affordance.
const EXTERNAL_ICON = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg>')`;

export const ROUTE_BIBLE_STYLES = `
.bible-ref {
  --rb-book-icon: ${BOOK_ICON};
  --rb-external-icon: ${EXTERNAL_ICON};
  display: inline-block;
  border-radius: 9999px;
  padding: 0.125rem 0.375rem;
  font-size: 0.85em;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--secondary);
  color: var(--secondary-foreground);
  text-decoration: none;
  white-space: nowrap;
  transition: transform 0.1s ease;
}

.bible-ref::before {
  content: "";
  display: inline-block;
  width: 1em;
  height: 1em;
  margin-right: 0.22em;
  vertical-align: -0.14em;
  background-color: currentColor;
  -webkit-mask: var(--rb-book-icon) no-repeat center / contain;
  mask: var(--rb-book-icon) no-repeat center / contain;
}

.bible-ref::after {
  content: "";
  display: inline-block;
  width: 0.7em;
  height: 0.7em;
  margin-left: 0.22em;
  background-color: currentColor;
  opacity: 0.7;
  -webkit-mask: var(--rb-external-icon) no-repeat center / contain;
  mask: var(--rb-external-icon) no-repeat center / contain;
}

.bible-ref:hover {
  filter: brightness(0.97);
}

.bible-ref:active {
  transform: translateY(1px);
}

.dark .bible-ref:hover {
  filter: brightness(1.12);
}
`;
