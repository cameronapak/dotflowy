// Links plugin (ADR 0001). Rich links -- `[label](url)` -- as a token plugin.
// The one token that FOLDS: it shows raw markdown only when the caret is on it
// (per-link reveal, ADR 0005), otherwise a clean <a>. Slice 1 ports the token
// render (Seam A); the delegated open (Seam B) and paste (Seam I) follow.
//
// The pure link layer (parse/strip/encode) stays in src/data/links.ts; this is
// just the decoration half expressed as El descriptors.

import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  isHttpUrl,
  LINK_PATTERN,
  sanitizeLinkLabel,
  swapLinkLabel,
} from "../../data/links";
import { getTreeIndex } from "../../data/tree-store";
import { definePlugin, type El } from "../types";

// Pull `[label](url)` apart for rendering. Mirrors the combined-regex shape, so
// it always matches what the tokenizer fed us.
const LINK_PARTS = /^\[([^\]]*)\]\(([^)]*)\)$/;

const LINK_CLASS = "node-link cursor-pointer underline underline-offset-2";

// The host of a folded link's url, for the favicon lookup -- or null if the url
// won't parse (a hand-typed rough edge). The token's url is percent-encoded for
// `( ) space` only, so `new URL` parses the scheme + host fine.
function linkHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

// The site's favicon, served by Google's long-lived s2/favicons endpoint, which
// falls back to a generic glyph on a miss -- so the <img> never shows a broken-
// image icon. Chosen over smaller services for longevity (it renders on every
// link, forever). `sz=64` stays crisp on hi-dpi at the small render box. It
// rides INSIDE the folded <a>, so a click on it opens the link like any other
// part of the anchor, and `loading="lazy"` keeps offscreen links cheap.
function faviconImgEl(host: string): El {
  return {
    tag: "img",
    attrs: {
      class: "link-favicon",
      src: `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
      alt: "",
      "aria-hidden": "true",
      draggable: "false",
      loading: "lazy",
    },
  };
}

// A folded link: a clean, ATOMIC <a> showing the site favicon + label. The whole
// `(url)` is hidden; `contenteditable="false"` makes it one indivisible caret
// unit. `data-src`/`data-src-len` carry the full markdown so the core's
// readSource can reconstruct it and the caret helpers can count it (ADR 0005) --
// readSource stops at the <a> and reads `data-src`, so the inner <img> never
// perturbs source/caret math. Attr order is preserved verbatim so the generated
// HTML stays byte-identical.
function foldedLinkEl(label: string, url: string, tok: string): El {
  const host = linkHost(url);
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
    children: host ? [faviconImgEl(host), label] : [label],
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

// While its title is being fetched, a just-pasted bare-url link wears this
// transient class (ADR 0016) -- CSS swaps its favicon slot for a spinner. Same
// one-shot-class mechanic as flash-node / rejectRow: applied imperatively here,
// removed on resolve; the success re-decorate replaces the <a> outright.
const UNFURLING_CLASS = "link-unfurling";

// Fetch a pasted URL's title from the auth-gated Worker endpoint (ADR 0016).
// Same-origin, so the session cookie rides along by default. Any failure -- a
// non-200, a malformed body, a network error -- collapses to null, and the
// caller keeps the url placeholder (the graceful fallback).
async function fetchLinkTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string | null };
    return typeof data.title === "string" && data.title ? data.title : null;
  } catch {
    return null;
  }
}

// The just-folded <a> for `token` inside `el` (matched on its `data-src`, which
// is the full link source), or null if it isn't there (the bullet was blurred,
// or re-decorated away by a keystroke before we looked).
function findFoldedAnchor(el: HTMLElement, token: string): HTMLElement | null {
  for (const a of el.querySelectorAll<HTMLElement>("a[data-link]")) {
    if (a.getAttribute("data-src") === token) return a;
  }
  return null;
}

// If the clipboard HTML is "essentially a single anchor" -- exactly one
// `<a href>` whose text is the whole payload -- return its text + http(s) href.
// Anything richer (a paragraph, multiple links, a table) returns null and falls
// back to plain text. Narrow on purpose (ADR 0005).
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
  //
  // Pasting a link (no selection) appends a trailing space so the caret lands
  // PAST the link: it's no longer under the caret, so it folds to a clean <a>
  // immediately instead of sitting revealed-raw until you click away. Wrapping
  // an existing SELECTION keeps the old end-of-link caret (no stray space).
  input: {
    onPaste: ({ plain, html, selectedText, hasSelection }) => {
      const selUrl = bareHttpUrl(plain);
      const anchor = hasSelection ? null : singleAnchor(html);
      if (hasSelection && selUrl)
        return `[${selectedText}](${encodeUrlForMarkdown(selUrl)})`;
      if (anchor)
        return `[${anchor.text}](${encodeUrlForMarkdown(anchor.href)}) `;
      if (!hasSelection && selUrl)
        return `[${selUrl}](${encodeUrlForMarkdown(selUrl)}) `;
      return null;
    },

    // Seam I (ADR 0016): after a bare-url paste lands, fetch the page title and
    // swap it into the label. Self-gates to OUR placeholder -- `[url](encUrl)`
    // whose label IS the url (encoding the label reproduces the url half). A
    // selection-wrap or anchor paste has a real-text label, so it's skipped.
    afterPaste: ({ inserted, nodeId, el }, ctx) => {
      const parts = LINK_PARTS.exec(inserted.trimEnd());
      if (!parts) return;
      const label = parts[1] ?? "";
      const encodedUrl = parts[2] ?? "";
      if (!isHttpUrl(label) || encodeUrlForMarkdown(label) !== encodedUrl) return;

      const token = `[${label}](${encodedUrl})`;
      const anchor = findFoldedAnchor(el, token);
      anchor?.classList.add(UNFURLING_CLASS);

      void fetchLinkTitle(label).then((title) => {
        // Drop the spinner. On success the swap re-decorates a fresh <a> anyway;
        // on failure this is what clears it (the text is unchanged).
        anchor?.classList.remove(UNFURLING_CLASS);
        if (!title) return; // keep the url placeholder
        const safe = sanitizeLinkLabel(title);
        if (!safe) return;
        // Read the LIVE text at swap time (not a paste-time snapshot): the user
        // may have typed since. Verbatim-match-or-drop (swapLinkLabel) does the
        // rest -- only an untouched placeholder is rewritten.
        const current = getTreeIndex().byId.get(nodeId)?.text;
        if (current == null) return;
        const next = swapLinkLabel(current, encodedUrl, label, safe);
        if (next != null) ctx.mutations.onTextChange(nodeId, next);
      });
    },
  },
});
