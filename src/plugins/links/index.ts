// Links plugin (ADR 0018). Rich links -- `[label](url)` -- as a token plugin.
// The one token that FOLDS: it shows raw markdown only when the caret is on it
// (per-link reveal, ADR 0017), otherwise a clean <a>. Slice 1 ports the token
// render (Seam A); the delegated open (Seam B) and paste (Seam I) follow.
//
// The pure link layer (parse/strip/encode) lives in ./links.ts; this is
// just the decoration half expressed as El descriptors.

import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  isHttpUrl,
  LINK_PATTERN,
} from "./links";
import { definePlugin, type El } from "../types";

// Pull `[label](url)` apart for rendering. Mirrors the combined-regex shape, so
// it always matches what the tokenizer fed us.
const LINK_PARTS = /^\[([^\]]*)\]\(([^)]*)\)$/;

const LINK_CLASS = "node-link cursor-pointer underline underline-offset-2";

// A folded link: a clean, ATOMIC <a> showing only the label. The whole `(url)`
// is hidden; `contenteditable="false"` makes it one indivisible caret unit.
// `data-src`/`data-src-len` carry the full markdown so the core's readSource
// can reconstruct it and the caret helpers can count it (ADR 0017). Attr order
// is preserved verbatim so the generated HTML stays byte-identical.
function foldedLinkEl(label: string, url: string, tok: string): El {
  return {
    tag: "a",
    attrs: {
      class: LINK_CLASS,
      "data-link": true,
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
    },
    children: [label],
  };
}

// A revealed link: the raw `[label](url)` as decorated spans whose combined
// textContent EQUALS the source (so it stays 1:1 with source offsets, like
// code/tag chips). The `[]()` punctuation is faint, the url is link-color.
function revealedLinkEl(label: string, url: string): El {
  const punct = (s: string): El => ({
    tag: "span",
    attrs: { class: "md-punct" },
    children: [s],
  });
  return {
    tag: "span",
    attrs: { class: "link-reveal", "data-link-reveal": true },
    children: [
      punct("["),
      { tag: "span", attrs: { class: "link-label" }, children: [label] },
      punct("]"),
      punct("("),
      { tag: "span", attrs: { class: "link-url" }, children: [url] },
      punct(")"),
    ],
  };
}

// If the clipboard HTML is "essentially a single anchor" -- exactly one
// `<a href>` whose text is the whole payload -- return its text + http(s) href.
// Anything richer (a paragraph, multiple links, a table) returns null and falls
// back to plain text. Narrow on purpose (ADR 0017).
function singleAnchor(html: string): { text: string; href: string } | null {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const anchors = doc.querySelectorAll("a[href]");
  if (anchors.length !== 1) return null;
  const a = anchors[0]!;
  const href = a.getAttribute("href") ?? "";
  const text = (a.textContent ?? "").trim();
  const bodyText = (doc.body.textContent ?? "").trim();
  if (!text || bodyText !== text || !isHttpUrl(href)) return null;
  return { text, href };
}

export default definePlugin({
  id: "links",
  tokens: [
    {
      id: "link",
      pattern: LINK_PATTERN,
      // First: the whole `[label](url)` is consumed as one opaque token, so a
      // `#tag` or `code` run inside a label/url never becomes its own chip.
      precedence: 0,
      folds: true,
      render: (tok, { revealOffset, start, end }) => {
        const parts = LINK_PARTS.exec(tok);
        const label = parts?.[1] ?? "";
        const url = parts?.[2] ?? "";
        const reveal =
          revealOffset != null && revealOffset >= start && revealOffset <= end;
        return reveal ? revealedLinkEl(label, url) : foldedLinkEl(label, url, tok);
      },
    },
  ],

  // Seam B: a folded link opens in a new tab; its mousedown blocks the editing
  // caret (editing a link is done from its edges -- click beside it reveals raw).
  interactions: [
    {
      selector: "a[data-link]",
      blockCaretOnMouseDown: true,
      onClick: (el, _ctx, e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = (el as HTMLAnchorElement).href;
        window.open(href, "_blank", "noopener,noreferrer");
      },
    },
  ],

  // Seam I: the three link-aware paste cases layered over the core's plain-text
  // baseline. URLs are percent-encoded so the simple parser never chokes (ADR
  // 0017). Returns null to defer to core plain-text when none apply.
  input: {
    onPaste: ({ plain, html, selectedText, hasSelection }) => {
      const selUrl = bareHttpUrl(plain);
      const anchor = hasSelection ? null : singleAnchor(html);
      if (hasSelection && selUrl)
        return `[${selectedText}](${encodeUrlForMarkdown(selUrl)})`;
      if (anchor) return `[${anchor.text}](${encodeUrlForMarkdown(anchor.href)})`;
      if (!hasSelection && selUrl)
        return `[${selUrl}](${encodeUrlForMarkdown(selUrl)})`;
      return null;
    },
  },
});
