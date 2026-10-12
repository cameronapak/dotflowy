// Links plugin (ADR 0001). Rich links -- `[label](url)` -- as a token plugin.
// The one token that FOLDS: it shows raw markdown only when the caret is on it
// (per-link reveal, ADR 0005), otherwise a clean <a>. Slice 1 ports the token
// render (Seam A); the delegated open (Seam B) and paste (Seam I) follow.
//
// The pure link layer (parse/strip/encode) stays in src/data/links.ts; this is
// just the decoration half expressed as El descriptors.

import { LinkIcon } from "lucide-react";

import {
  getSelectionRange,
  mdPunct,
  readSource,
  sourceOffsetUpTo,
} from "../../components/inline-code";
import { openUrlInFocusedTab } from "../../components/open-url";
import { getEditorFeatures } from "../../data/editor-features";
import { unfurlLinks } from "../../data/link-unfurl";
import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  isHttpUrl,
  LINK_PATTERN,
} from "../../data/links";
import { getTreeIndex } from "../../data/tree-store";
import { isRevealed, resolveNodeId } from "../token-kit";
import { definePlugin, type El, type PluginContext } from "../types";
import { LINK_FILTER_OPERATORS } from "./filter-operators";
import {
  openLinkCreatePopover,
  openLinkEditPopover,
} from "./link-edit-popover";
import { unfurlNodeLinks } from "./unfurl";

// Pull `[label](url)` apart for rendering. Mirrors the combined-regex shape, so
// it always matches what the tokenizer fed us.
const LINK_PARTS = /^\[([^\]]*)\]\(([^)]*)\)$/;

const LINK_CLASS = "node-link cursor-pointer";

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

// A text-free icon, painted by CSS mask inside the accessible pencil button.
function editIconEl(): El {
  return {
    tag: "span",
    attrs: { class: "link-edit-icon", "aria-hidden": "true" },
  };
}

function editButtonEl(token?: string): El {
  return {
    tag: "button",
    attrs: {
      type: "button",
      class: "link-edit-button",
      "aria-label": "Edit link",
      title: "Edit link",
      contenteditable: "false",
      "data-src": "",
      "data-src-len": 0,
      "data-link-token": token,
    },
    children: [editIconEl()],
  };
}

// The wrapper is one source atom. The anchor visits the URL and the sibling
// pencil edits it, without nesting interactive controls inside the anchor.
// Plain URLs use the same wrapper without a favicon or metadata lookup.
function foldedLinkEl(
  label: string,
  url: string,
  tok: string,
  plain = false,
): El {
  const host = plain ? null : linkHost(url);
  const start = label.match(/^\s*\S/u)?.[0] ?? label;
  return {
    tag: "span",
    attrs: {
      class: "link-with-editor",
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
    },
    children: [
      {
        tag: "a",
        attrs: {
          class: LINK_CLASS,
          "data-link": !plain,
          "data-plain-url": plain,
          contenteditable: "false",
          "data-src": tok,
          "data-src-len": tok.length,
          href: url,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        children: host
          ? [
              {
                tag: "span",
                attrs: { class: "link-start" },
                children: [faviconImgEl(host), start],
              },
              label.slice(start.length),
            ]
          : [label],
      },
      editButtonEl(),
    ],
  };
}

// A revealed link (bracket reveal, ADR 0005): `[label]` as editable text -- the
// brackets appear so the label edits as raw markdown -- but the URL itself
// NEVER expands into the line. Only the bare `url` folds to one atomic chip
// (`data-src` carries it, so readSource still reconstructs the full token and
// the caret jumps over it) rendered as a pencil; the parens around it are REAL
// text, so the caret walks through `](` and `)` one step at a time, and typing
// between `]` and `(` breaks the token match -- the link splits open to raw
// text. Clicking the chip opens the Edit Link popover. Everything except the
// chip stays 1:1 with its slice of the source.
function revealedLinkEl(label: string, url: string): El {
  return {
    tag: "span",
    attrs: { class: "link-reveal", "data-link-reveal": true },
    children: [
      mdPunct("["),
      { tag: "span", attrs: { class: "link-label" }, children: [label] },
      mdPunct("]"),
      mdPunct("("),
      {
        tag: "button",
        attrs: {
          class: "link-url-chip",
          "data-src": url,
          "data-src-len": url.length,
          contenteditable: "false",
          title: "Edit link",
          type: "button",
          "aria-label": "Edit link",
        },
        children: [editIconEl()],
      },
      mdPunct(")"),
    ],
  };
}

// Resolve a click on an edit affordance to (nodeId, token, pencil rect) and
// open the popover. A folded link's sibling pencil reads the full token off
// the anchor's data-src; the revealed url chip reads its own data-src (the
// bare url) plus the label from the sibling span (fresh -- every keystroke
// re-decorates). The node id comes from the enclosing row's `data-node-id`;
// the zoomed title has no row, so it falls back to the zoom root (which IS
// the title's node).
function openEditFor(el: HTMLElement, ctx: PluginContext): void {
  const wrapper = el.closest<HTMLElement>(".link-with-editor");
  const anchor =
    wrapper?.querySelector<HTMLElement>("a[data-link], a[data-plain-url]") ??
    el.closest<HTMLElement>("a[data-link]");
  let token: string;
  const plainToken = el.getAttribute("data-link-token");
  if (plainToken) {
    token = plainToken;
  } else if (anchor) {
    token = anchor.getAttribute("data-src") ?? "";
  } else {
    const chip = el.closest<HTMLElement>(".link-url-chip");
    if (!chip) return;
    const reveal = chip.closest<HTMLElement>(".link-reveal");
    const label = reveal?.querySelector(".link-label")?.textContent ?? "";
    token = `[${label}](${chip.getAttribute("data-src") ?? ""})`;
  }
  const parts = LINK_PARTS.exec(token);
  if (!parts && !bareHttpUrl(token)) return;
  const nodeId = resolveNodeId(el);
  if (!nodeId) return;
  const textEl = el.closest<HTMLElement>(".node-text");
  const tokenEl = wrapper ?? el.closest<HTMLElement>(".link-reveal") ?? anchor;
  const parent = tokenEl?.parentNode;
  if (!textEl || !tokenEl || !parent) return;
  const start = sourceOffsetUpTo(
    textEl,
    parent,
    Array.from(parent.childNodes).indexOf(tokenEl),
  );
  const source = readSource(textEl);
  const end = start + token.length;
  if (source.slice(start, end) !== token) return;
  const buttons = textEl?.querySelectorAll<HTMLElement>(
    ".link-edit-button, .link-url-chip",
  );
  const buttonIndex = buttons ? Array.from(buttons).indexOf(el) : -1;
  const rect = el.getBoundingClientRect();
  openLinkEditPopover(
    {
      nodeId,
      token,
      source,
      start,
      end,
      label: parts?.[1] ?? "",
      url: parts?.[2] ?? token,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 6,
      restoreFocus: () => {
        const button = textEl?.querySelectorAll<HTMLElement>(
          ".link-edit-button, .link-url-chip",
        )[buttonIndex];
        (button ?? textEl)?.focus({ preventScroll: true });
      },
    },
    ctx,
  );
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

// Seam C `/link` + the desktop toolbar's link button (ADR 0036): wrap the
// current selection in a link and open the edit popover to fill the url. Reads
// the focused contentEditable directly (the same seam wrap.ts uses); resolves a
// mirror row to its source node so the write lands where the text lives. With no
// selection it opens the popover with an empty label (type both). Positioned at
// the selection rect, falling back to the span.
function createLinkFromSelection(nodeId: string, ctx: PluginContext): void {
  // SAFETY: document.activeElement is an Element or null, elements here are HTMLElements
  const el = document.activeElement as HTMLElement | null;
  if (!el || !el.isContentEditable) return;

  const contentId = getTreeIndex().byId.get(nodeId)?.mirrorOf ?? nodeId;
  const source = readSource(el);
  const range = getSelectionRange(el) ?? {
    start: source.length,
    end: source.length,
  };
  const selText = source.slice(range.start, range.end);

  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  const sel = window.getSelection();
  const rect =
    sel && sel.rangeCount > 0
      ? sel.getRangeAt(0).getBoundingClientRect()
      : el.getBoundingClientRect();
  if (rect.width || rect.height) {
    x = rect.left;
    y = rect.bottom + 6;
  }

  openLinkCreatePopover(
    {
      nodeId: contentId,
      source,
      start: range.start,
      end: range.end,
      selText,
      x,
      y,
    },
    ctx,
  );
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
      render: (tok, view) => {
        const parts = LINK_PARTS.exec(tok);
        const label = parts?.[1] ?? "";
        const url = parts?.[2] ?? "";
        return isRevealed(view)
          ? revealedLinkEl(label, url)
          : foldedLinkEl(label, url, tok);
      },
    },
    {
      id: "plain-url",
      pattern: "[Hh][Tt][Tt][Pp][Ss]?:\\/\\/[^\\s<>\\x60|\\[\\]]+",
      precedence: 0,
      folds: true,
      render: (tok, view) => {
        const link = unfurlLinks(tok)[0];
        if (!link || !bareHttpUrl(link.token))
          return { tag: "span", children: [tok] };
        if (!isRevealed(view)) {
          // Plain URLs keep their literal label, without a title or favicon.
          return {
            tag: "span",
            children: [
              foldedLinkEl(link.token, link.url, link.token, true),
              tok.slice(link.token.length),
            ],
          };
        }
        return {
          tag: "span",
          attrs: { class: "link-with-editor" },
          children: [tok, editButtonEl(link.token)],
        };
      },
    },
  ],

  // Seam C: `/link` wraps the selection in a link and opens the edit popover.
  // caretScoped -- it needs the live selection the overlay-based Cmd+K can't hold
  // (ADR 0034), so it's a slash-palette + toolbar action, not a command-center
  // row. The desktop selection toolbar (ADR 0036) runs this same command.
  commands: [
    {
      id: "link",
      label: "Link",
      description: "Wrap the selection in a link",
      icon: LinkIcon,
      keywords: ["link", "url", "hyperlink", "anchor", "href"],
      available: () => true,
      caretScoped: true,
      run: (nodeId: string, ctx: PluginContext) =>
        createLinkFromSelection(nodeId, ctx),
    },
  ],

  // Seam B: the pencil beside a folded anchor or inside the revealed URL chip
  // opens the editor. The destination anchor opens in a new tab. A
  // folded link itself opens in a new tab; its mousedown blocks the editing
  // caret (editing the label is done from its edges -- click beside it reveals
  // the brackets; editing the url is the popover's job).
  interactions: [
    {
      selector: ".link-edit-button, .link-url-chip",
      blockCaretOnMouseDown: true,
      onClick: (el, ctx, e) => {
        e.preventDefault();
        e.stopPropagation();
        openEditFor(el, ctx);
      },
    },
    {
      selector: "a[data-link], a[data-plain-url]",
      blockCaretOnMouseDown: true,
      onClick: (el, _ctx, e) => {
        e.preventDefault();
        e.stopPropagation();
        // SAFETY: the selector "a[data-link]" matched, so el is an anchor
        const href = (el as HTMLAnchorElement).href;
        const textEl = el.closest<HTMLElement>(".node-text");
        openUrlInFocusedTab(href, {
          restoreFocus: () => textEl?.focus({ preventScroll: true }),
        });
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
      const preferences = getEditorFeatures();
      const choiceUrl =
        !hasSelection && (!preferences.ready || preferences.embeds)
          ? bareHttpUrl(plain)
          : null;
      // Standalone URLs wait for an explicit display choice before any lookup.
      if (choiceUrl) return choiceUrl;
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

    // Full source supplies code/spoiler context; the old source prevents backfill.
    afterPaste: ({ before, text, nodeId, el }, ctx) => {
      const preferences = getEditorFeatures();
      if (
        !before.trim() &&
        (!preferences.ready || preferences.embeds) &&
        el?.closest(".outline-row, .zoomed-title") &&
        bareHttpUrl(text)
      )
        return;
      unfurlNodeLinks(nodeId, before, text, ctx, el);
    },
  },

  // Query filter (ADR 0047 §4): `has:link` -- a markdown `[label](url)` run in
  // the text. Reuses the pure `hasLink` (bails before any regex on `[`-free
  // text), so the predicate is O(1) on the overwhelming majority of nodes.
  filterOperators: LINK_FILTER_OPERATORS,
});
