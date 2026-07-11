// Links plugin (ADR 0001). Rich links -- `[label](url)` -- as a token plugin.
// The one token that FOLDS: it shows raw markdown only when the caret is on it
// (per-link reveal, ADR 0005), otherwise a clean <a>. Slice 1 ports the token
// render (Seam A); the delegated open (Seam B) and paste (Seam I) follow.
//
// The pure link layer (parse/strip/encode) stays in src/data/links.ts; this is
// just the decoration half expressed as El descriptors.

import { Duration, Effect } from "effect";
import { LinkIcon } from "lucide-react";

import {
  getSelectionRange,
  mdPunct,
  readSource,
} from "../../components/inline-code";
import { openUrlInFocusedTab } from "../../components/open-url";
import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  hasLink,
  isHttpUrl,
  LINK_PATTERN,
  sanitizeLinkLabel,
  swapLinkLabel,
} from "../../data/links";
import { getTreeIndex } from "../../data/tree-store";
import { isRevealed, resolveNodeId } from "../token-kit";
import { definePlugin, type El, type PluginContext } from "../types";
import {
  openLinkCreatePopover,
  openLinkEditPopover,
} from "./link-edit-popover";

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

// The trailing pencil affordance -- a text-free span (icon painted by CSS mask)
// that opens the Edit Link popover. Inside a folded <a> it's invisible to
// source/caret math (readSource stops at the atom's `data-src`); inside the
// revealed url chip it's interior to that atom, same story.
function editIconEl(): El {
  return {
    tag: "span",
    attrs: { class: "link-edit-icon", "aria-hidden": "true" },
  };
}

// A folded link: a clean, ATOMIC <a> showing the site favicon + label + the
// edit pencil. The whole `(url)` is hidden; `contenteditable="false"` makes it
// one indivisible caret unit. `data-src`/`data-src-len` carry the full markdown
// so the core's readSource can reconstruct it and the caret helpers can count
// it (ADR 0005) -- readSource stops at the <a> and reads `data-src`, so the
// inner <img>/pencil never perturb source/caret math. Attr order is preserved
// verbatim so the generated HTML stays byte-identical.
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
    children: host
      ? [faviconImgEl(host), label, editIconEl()]
      : [label, editIconEl()],
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
        tag: "span",
        attrs: {
          class: "link-url-chip",
          "data-src": url,
          "data-src-len": url.length,
          contenteditable: "false",
          title: "Edit link",
        },
        children: [editIconEl()],
      },
      mdPunct(")"),
    ],
  };
}

// Resolve a click on an edit affordance to (nodeId, token, anchor rect) and
// open the popover. The pencil inside a folded <a> reads the full token off
// the anchor's data-src; the revealed url chip reads its own data-src (the
// bare url) plus the label from the sibling span (fresh -- every keystroke
// re-decorates). The node id comes from the enclosing row's `data-node-id`;
// the zoomed title has no row, so it falls back to the zoom root (which IS
// the title's node).
function openEditFor(el: HTMLElement, ctx: PluginContext): void {
  const anchor = el.closest<HTMLElement>("a[data-link]");
  let token: string;
  let rectEl: HTMLElement;
  if (anchor) {
    token = anchor.getAttribute("data-src") ?? "";
    rectEl = anchor;
  } else {
    const chip = el.closest<HTMLElement>(".link-url-chip");
    if (!chip) return;
    const reveal = chip.closest<HTMLElement>(".link-reveal");
    const label = reveal?.querySelector(".link-label")?.textContent ?? "";
    token = `[${label}](${chip.getAttribute("data-src") ?? ""})`;
    rectEl = reveal ?? chip;
  }
  const parts = LINK_PARTS.exec(token);
  if (!parts) return;
  const nodeId = resolveNodeId(el);
  if (!nodeId) return;
  const textEl = el.closest<HTMLElement>(".node-text");
  const rect = rectEl.getBoundingClientRect();
  openLinkEditPopover(
    {
      nodeId,
      token,
      label: parts[1] ?? "",
      url: parts[2] ?? "",
      x: rect.left,
      y: rect.bottom + 6,
      restoreFocus: () => textEl?.focus({ preventScroll: true }),
    },
    ctx,
  );
}

// While its title is being fetched, a just-pasted bare-url link wears this
// transient class (ADR 0016) -- CSS swaps its favicon slot for a spinner. Same
// one-shot-class mechanic as flash-node / rejectRow: applied imperatively here,
// removed on resolve; the success re-decorate replaces the <a> outright.
const UNFURLING_CLASS = "link-unfurling";

// Fetch a pasted URL's title from the auth-gated Worker endpoint (ADR 0016), as
// an Effect. Same-origin, so the session cookie rides along by default. Any
// failure -- a non-200, a malformed body, a network error -- collapses to null,
// and the caller keeps the url placeholder (the graceful fallback). The runtime
// `signal` wires the fetch up to be interruptible; nothing interrupts it per
// node today (see the runFork site), so it runs to completion either way.
function fetchLinkTitleE(url: string): Effect.Effect<string | null> {
  return Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`, {
        signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { title?: string | null };
      return typeof data.title === "string" && data.title ? data.title : null;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(8),
      orElse: () => Effect.succeed<string | null>(null),
    }),
    Effect.orElseSucceed(() => null),
  );
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

// Seam C `/link` + the desktop toolbar's link button (ADR 0036): wrap the
// current selection in a link and open the edit popover to fill the url. Reads
// the focused contentEditable directly (the same seam wrap.ts uses); resolves a
// mirror row to its source node so the write lands where the text lives. With no
// selection it opens the popover with an empty label (type both). Positioned at
// the selection rect, falling back to the span.
function createLinkFromSelection(nodeId: string, ctx: PluginContext): void {
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

  // Seam B: the edit pencil (in a folded <a> AND the revealed `(url)` chip)
  // opens the Edit Link popover -- listed FIRST so a click on the pencil inside
  // the anchor dispatches here, not to the open-in-new-tab handler below. A
  // folded link itself opens in a new tab; its mousedown blocks the editing
  // caret (editing the label is done from its edges -- click beside it reveals
  // the brackets; editing the url is the popover's job).
  interactions: [
    {
      selector: ".link-edit-icon, .link-url-chip",
      blockCaretOnMouseDown: true,
      onClick: (el, ctx, e) => {
        e.preventDefault();
        e.stopPropagation();
        openEditFor(el, ctx);
      },
    },
    {
      selector: "a[data-link]",
      blockCaretOnMouseDown: true,
      onClick: (el, _ctx, e) => {
        e.preventDefault();
        e.stopPropagation();
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
      if (!isHttpUrl(label) || encodeUrlForMarkdown(label) !== encodedUrl)
        return;

      const token = `[${label}](${encodedUrl})`;
      const anchor = findFoldedAnchor(el, token);
      anchor?.classList.add(UNFURLING_CLASS);

      // Run the unfurl through the plugin async seam (ctx.run, ADR 0039): a
      // tracked fiber on the shared runtime, interrupted on editor unmount. It's
      // editor-scoped, not node-scoped -- nothing interrupts it when just the
      // bullet is deleted, so the continuation's own guards (current == null,
      // verbatim swapLinkLabel match) are what keep a late title from writing
      // into a deleted or since-edited bullet.
      ctx.run(
        fetchLinkTitleE(label).pipe(
          Effect.flatMap((title) =>
            Effect.sync(() => {
              // Drop the spinner. On success the swap re-decorates a fresh <a>
              // anyway; on failure this is what clears it (text unchanged).
              anchor?.classList.remove(UNFURLING_CLASS);
              if (!title) return; // keep the url placeholder
              const safe = sanitizeLinkLabel(title);
              if (!safe) return;
              // Read the LIVE text at swap time (not a paste-time snapshot): the
              // user may have typed since. Verbatim-match-or-drop (swapLinkLabel)
              // does the rest -- only an untouched placeholder is rewritten, and
              // a deleted node (current == null) is skipped.
              const current = getTreeIndex().byId.get(nodeId)?.text;
              if (current == null) return;
              const next = swapLinkLabel(current, encodedUrl, label, safe);
              if (next != null) ctx.mutations.onTextChange(nodeId, next);
            }),
          ),
        ),
      );
    },
  },

  // Query filter (ADR 0047 §4): `has:link` -- a markdown `[label](url)` run in
  // the text. Reuses the pure `hasLink` (bails before any regex on `[`-free
  // text), so the predicate is O(1) on the overwhelming majority of nodes.
  filterOperators: [
    {
      key: "has",
      values: ["link"],
      description: "Filter to nodes containing a link",
      predicate: (node) => hasLink(node.text),
    },
  ],
});
