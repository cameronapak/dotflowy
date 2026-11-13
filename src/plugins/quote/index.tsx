// Quote plugin (ADR 0079). A node whose text source starts with `> ` reads as a
// quote. Quote-ness is derived from the text, like emphasis, so this plugin
// owns the inline syntax only:
//
//  - Seam A: the leading `> ` as a FOLDING token. Folded, it is an empty atom
//    (`data-src="> "`), so the quote reads clean. With the caret at offsets 0
//    to 2 it reveals as dimmed `.md-punct` text (ADR 0025's reveal rule). An
//    empty quote (`> ` alone) does not fold; see `QUOTE_PATTERN`.
//  - Seam C: `/quote`, which adds or removes the marker.
//  - Seam K: `is:quote`.
//
// The signifier is core: the bar that replaces the dot in `BulletGlyph`, and the
// zoomed title's bar, read `isQuoteText` the way the paragraph glyph reads
// `kind` (ADR 0045). The marker Backspace, the empty-quote Enter, and the Enter
// carry-forward are core editor behavior too (`quote-marker.ts`, the row
// keymap, and `OutlineEditor`'s `onEnter`).

import { TextQuoteIcon } from "@/lib/icons";

import {
  decorate,
  getCaretOffset,
  readSource,
  setCaretOffset,
} from "../../components/inline-code";
import { activeEditable } from "../../components/wrap";
import {
  isQuoteText,
  QUOTE_MARKER,
  QUOTE_PATTERN,
  toggleQuoteMarker,
} from "../../data/quote";
import { isRevealed } from "../token-kit";
import { definePlugin, type PluginContext, type TokenView } from "../types";
import { QUOTE_FILTER_OPERATORS } from "./filter-operators";

function renderMarker(tok: string, view: TokenView) {
  if (isRevealed(view))
    return {
      tag: "span",
      attrs: { class: "md-punct quote-marker-reveal" },
      children: [tok],
    };
  return {
    tag: "span",
    attrs: {
      class: "quote-marker",
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
    },
    children: [],
  };
}

/** Add or remove the marker. In the focused editor for this node, read the
 *  live DOM source and keep the caret on the same character; elsewhere (Cmd+K
 *  with no caret) write the stored text and let the reconciler repaint. */
function toggleQuote(nodeId: string, ctx: PluginContext) {
  const el = activeEditable();
  if (el && el.dataset.historyNodeId === nodeId) {
    const source = readSource(el);
    const caret = getCaretOffset(el);
    const next = toggleQuoteMarker(source);
    const delta = isQuoteText(source)
      ? -QUOTE_MARKER.length
      : QUOTE_MARKER.length;
    const nextCaret = Math.max(0, caret + delta);
    ctx.mutations.onTextChange(nodeId, next);
    decorate(el, next, nextCaret, false);
    setCaretOffset(el, nextCaret);
    return;
  }
  const node = ctx.tree.byId.get(nodeId);
  if (node) ctx.mutations.onTextChange(nodeId, toggleQuoteMarker(node.text));
}

export default definePlugin({
  id: "quote",

  // Anchored to the start of the text. No other token starts with `>`, so the
  // precedence never decides an overlap; 45 sorts it after spoiler (40).
  tokens: [
    {
      id: "quote-marker",
      pattern: QUOTE_PATTERN,
      precedence: 45,
      folds: true,
      render: renderMarker,
    },
  ],

  commands: [
    {
      id: "quote",
      label: "Quote",
      description: "Add or remove the quote marker",
      icon: TextQuoteIcon,
      keywords: ["quote", "citation", "cite", "into"],
      available: () => true,
      run: toggleQuote,
    },
  ],

  filterOperators: QUOTE_FILTER_OPERATORS,
});
