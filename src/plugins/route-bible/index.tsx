// Route Bible plugin (ADR 0026). A Scripture reference in `node.text` -> a
// clickable chip that opens route.bible. Seam A (the chip render) + Seam B (the
// delegated open) -- the same two seams the `links` plugin uses, minus the fold.
//
// Detection is liberal-regex-PROPOSES (BIBLE_REF_PATTERN) /
// grab-bcv-parser-DISPOSES (resolveBibleRef returns null -> the core renders raw
// text). NON-FOLDING, like a #tag: the chip's text equals its source, so the
// caret moves through it normally and no fold/reveal/source-offset machinery is
// needed. The pure layer (pattern + parse + URL) lives in ./bible.ts.

import { BIBLE_REF_PATTERN, resolveBibleRef } from "./bible";
import { definePlugin, type El } from "../types";
import { ROUTE_BIBLE_STYLES } from "./styles";

// The chip is a single `.bible-ref` span -- a token render serializes to HTML,
// so it can't render <Badge> (same reason the tag chip is a plain span, ADR
// 0018). All of its styling (pill shape, color, icons, press-bounce) lives in
// the plugin's OWN stylesheet (styles.ts, mounted via the plugin styles seam,
// ADR 0027) -- nothing in core styles.css. `.bible-ref` is also the delegated
// click handler's hook, and `data-href` carries the resolved route.bible URL.
function bibleRefEl(tok: string, url: string): El {
  return {
    tag: "span",
    attrs: { class: "bible-ref", "data-bible-ref": true, "data-href": url },
    children: [tok],
  };
}

export default definePlugin({
  id: "route-bible",
  styles: ROUTE_BIBLE_STYLES,
  tokens: [
    {
      id: "bible-ref",
      pattern: BIBLE_REF_PATTERN,
      // After links (0) and code (10): a reference inside a `[label](url)` or a
      // `code` run stays owned by those. Non-folding -- the chip text IS the
      // source (no `data-src`), so caret offsets stay 1:1.
      precedence: 15,
      render: (tok) => {
        const ref = resolveBibleRef(tok);
        // Regex proposes, parser disposes: a non-reference ("Hello 3") falls
        // through to plain text, never a chip.
        return ref ? bibleRefEl(tok, ref.url) : tok;
      },
    },
  ],

  // Seam B: a chip opens its route.bible URL in a new tab; its mousedown blocks
  // the editing caret (the chip lives inside the contentEditable). Mirrors the
  // links plugin's open-on-click.
  interactions: [
    {
      selector: "span[data-bible-ref]",
      blockCaretOnMouseDown: true,
      onClick: (el, _ctx, e) => {
        const href = el.dataset.href;
        if (!href) return;
        e.preventDefault();
        e.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      },
    },
  ],
});
