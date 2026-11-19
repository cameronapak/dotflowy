// Pure El descriptors for the links plugin's two token renders (Seam A): the
// folded anchor and the bracket-revealed form. DOM-free, so unit tests render
// them without loading the editor core.

import type { El, TokenView, WidgetEl } from "../types";

import { safeLinkHref } from "../../data/links";
import { mdPunct } from "../token-kit";

// Pull `[label](url)` apart for rendering. Mirrors the combined-regex shape, so
// it always matches what the tokenizer fed us.
export const LINK_PARTS = /^\[([^\]]*)\]\(([^)]*)\)$/;

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

export function editButtonEl(token?: string): El {
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
// Plain URLs use the same wrapper without a favicon or metadata lookup. A url
// outside the http/https/mailto allowlist renders as an inert, href-less
// anchor: the label shows and the pencil still edits it, but nothing opens.
export function foldedLinkEl(
  label: string,
  url: string,
  tok: string,
  plain = false,
  labelElements: (El | WidgetEl)[] = [label],
): El {
  const href = safeLinkHref(url);
  const host = plain || !href ? null : linkHost(url);
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
          href: href ?? undefined,
          target: href ? "_blank" : undefined,
          rel: href ? "noopener noreferrer" : undefined,
          "data-unsafe-link": !href,
          title: href ? undefined : "Blocked link: unsupported URL scheme",
        },
        children:
          host && labelElements.length > 1
            ? [faviconImgEl(host), ...labelElements]
            : host
              ? [
                  {
                    tag: "span",
                    attrs: { class: "link-start" },
                    children: [faviconImgEl(host), start],
                  },
                  label.slice(start.length),
                ]
              : labelElements,
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
export function revealedLinkEl(
  label: string,
  url: string,
  view: TokenView,
): El {
  return {
    tag: "span",
    attrs: { class: "link-reveal", "data-link-reveal": true },
    children: [
      mdPunct("["),
      {
        tag: "span",
        attrs: { class: "link-label" },
        children: view.renderInline(label, view.start + 1, true),
      },
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
