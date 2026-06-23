// Shared inline decoration for contentEditable bullet/title text: `code` runs,
// #tags, and rich links.
//
// Both the outline bullets (OutlineNode) and the zoomed page title
// (OutlineEditor's ZoomedTitle) render their stored markdown as live HTML:
// the contentEditable always holds formatted output (mono chips, tag chips,
// folded links), and each keystroke re-tokenizes the line and rebuilds its DOM.
// The caret is saved as an absolute SOURCE-character offset before the rebuild
// and restored after.
//
// Code runs and #tags keep their FULL source visible (backticks, the leading
// `#`), so for them the source string and the rendered text have identical
// length. Links are the exception: a link FOLDS to a clean <a> (shorter than
// its `[label](url)` source) unless the caret is on it (per-link reveal, ADR
// 0017). A folded link is therefore an atomic widget whose displayed length
// (the label) differs from its source length -- the caret helpers below correct
// for that so every consumer keeps speaking source offsets.

import { TAG_PATTERN } from "../data/tags";
import { LINK_PATTERN } from "../data/links";

// Inline `code` runs: `like this`. Single-line, non-empty, no nested backtick.
const CODE_RUN = "`[^`\\n]+`";

// One pass over links, code runs, and tags, in document order. Links are listed
// FIRST so the whole `[label](url)` is consumed as one opaque token -- a `#tag`
// or `code` run *inside* a link's label/url never becomes its own chip. Code
// then precedes tags so a `#tag` inside a code run (e.g. `#define`) stays code.
const TOKEN = new RegExp(`${LINK_PATTERN}|${CODE_RUN}|${TAG_PATTERN}`, "gu");

const CODE_CLASS =
  "rounded-[4px] border border-border/60 bg-muted px-0.5 py-0.5 font-mono text-[0.85em] text-foreground";

// Tag chips borrow the Badge shape (ui/badge.tsx) -- a rounded-full pill --
// applied as an inline utility string because the chip is injected via
// innerHTML, not rendered as the <Badge> component. By default a chip is a
// neutral outline (the `.tag` rule in styles.css, border-border); a chosen
// color fills it via the generated stylesheet keyed by `data-tag` (ADR 0016).
// `.tag` is also the delegated click handler's hook (OutlineEditor).
const TAG_CLASS =
  "tag rounded-full px-1.5 py-0.5 text-[0.85em] font-medium cursor-pointer";

// Folded link: a clean, ATOMIC <a> showing only the label. The whole `(url)` is
// hidden, and `contenteditable="false"` makes it one indivisible caret unit --
// the caret can sit before or after it but never inside (entering its boundary
// is what reveals it). `data-src`/`data-src-len` carry the full markdown so
// readSource can reconstruct it and the caret helpers can count it. Opened
// (never caret-placed) by the delegated handler in OutlineEditor. See ADR 0017.
const LINK_CLASS = "node-link cursor-pointer underline underline-offset-2";

// Parse one `[label](url)` token. Returns null on the (impossible-here) shapes
// the combined regex wouldn't have matched.
const LINK_PARTS = /^\[([^\]]*)\]\(([^)]*)\)$/;

// Last HTML we wrote to each element, so decorate() can skip a rebuild (and the
// caret jitter it causes) when nothing visible changed. Keyed by the element so
// it's compared against OUR generated string, never the browser's re-serialized
// innerHTML (which normalizes boolean attrs like `data-link` and would never
// match). A caret move that doesn't change the active link produces identical
// HTML, so the selectionchange reflow becomes a cheap no-op.
const renderCache = new WeakMap<HTMLElement, string>();

// Build the display HTML for a line of text. Walks link/code/tag tokens in
// order, escaping the plain text between them (user input going into innerHTML)
// and wrapping each token.
//
// `revealOffset` is the caret's SOURCE offset, or null when the bullet is
// blurred. A link REVEALS (raw, decorated `[label](url)`) iff the caret sits
// within or adjacent to it (offset in `[start, end]`, boundaries inclusive so
// you can arrow/click in from either edge); otherwise it FOLDS to a clean <a>.
// At most one link reveals -- the one under the caret. Code and tags keep their
// source visible in both states. See ADR 0017 (per-link reveal).
export function inlineMarkupHtml(
  text: string,
  revealOffset: number | null,
): string {
  let html = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const tok = m[0];
    html += escapeHtml(text.slice(last, start));
    const first = tok.charCodeAt(0);
    if (first === 91 /* [ -> link */) {
      const end = start + tok.length;
      const parts = LINK_PARTS.exec(tok);
      const label = parts?.[1] ?? "";
      const url = parts?.[2] ?? "";
      const reveal =
        revealOffset != null && revealOffset >= start && revealOffset <= end;
      html += reveal
        ? revealedLinkHtml(label, url)
        : foldedLinkHtml(label, url, tok);
    } else if (first === 96 /* backtick -> code */) {
      html += `<code class="${CODE_CLASS}">${escapeHtml(tok)}</code>`;
    } else {
      const name = tok.slice(1);
      html += `<span class="${TAG_CLASS}" data-tag="${name}">${escapeHtml(tok)}</span>`;
    }
    last = start + tok.length;
  }
  html += escapeHtml(text.slice(last));
  return html;
}

// A folded link: clean label, the markdown source carried in data-* for
// reconstruction. contenteditable=false makes it atomic.
function foldedLinkHtml(label: string, url: string, tok: string): string {
  return (
    `<a class="${LINK_CLASS}" data-link contenteditable="false"` +
    ` data-src="${escapeAttr(tok)}" data-src-len="${tok.length}"` +
    ` href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">` +
    `${escapeHtml(label)}</a>`
  );
}

// A revealed link: the raw `[label](url)` as decorated spans whose combined
// textContent EQUALS the source (so it stays 1:1 with source offsets, exactly
// like code/tag chips). The `[]()` punctuation is faint, the url is link-color.
function revealedLinkHtml(label: string, url: string): string {
  return (
    `<span class="link-reveal" data-link-reveal>` +
    `<span class="md-punct">[</span>` +
    `<span class="link-label">${escapeHtml(label)}</span>` +
    `<span class="md-punct">]</span>` +
    `<span class="md-punct">(</span>` +
    `<span class="link-url">${escapeHtml(url)}</span>` +
    `<span class="md-punct">)</span>` +
    `</span>`
  );
}

// Quote/angle-bracket-safe attribute value for the link href + data-src (they
// can carry arbitrary chars; encodeUrlForMarkdown only handles `( ) space`).
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// True for a folded-link atomic widget (an <a> carrying its markdown source).
// Revealed links are spans (no data-src), so they read back 1:1 as plain text.
function isFoldedLink(node: Node): node is HTMLElement {
  return (
    node.nodeType === 1 &&
    (node as HTMLElement).hasAttribute("data-link") &&
    (node as HTMLElement).hasAttribute("data-src")
  );
}

function foldedSrcLen(el: HTMLElement): number {
  const n = Number(el.getAttribute("data-src-len"));
  return Number.isFinite(n) && n > 0
    ? n
    : (el.getAttribute("data-src") ?? "").length;
}

// Reconstruct the markdown SOURCE from the live DOM. el.textContent is no longer
// the source once a focused bullet can hold folded links (they show only their
// label), so onInput/onCompositionEnd/paste read through this instead: walk the
// tree emitting `data-src` for folded links and textContent for everything else
// (revealed-link spans, code, and tags are all 1:1 with their source). See ADR
// 0017 (per-link reveal).
export function readSource(el: HTMLElement): string {
  let out = "";
  const visit = (node: Node) => {
    if (node.nodeType === 3 /* text */) {
      out += node.textContent ?? "";
      return;
    }
    if (isFoldedLink(node)) {
      out += node.getAttribute("data-src") ?? "";
      return;
    }
    node.childNodes.forEach(visit);
  };
  el.childNodes.forEach(visit);
  return out;
}

// Re-render `el` as formatted HTML, optionally keeping the caret put. The DOM
// rebuild invalidates any (node, offset) selection, so we capture the caret as
// an absolute SOURCE-character offset first and re-derive it against the new
// tree after. We rebuild only when the generated HTML actually changed (the
// render cache), avoiding needless rebuilds -- and the caret flicker they cause
// -- when the text and the active (revealed) link are both unchanged.
//
// `revealOffset` decides which link, if any, shows raw; see inlineMarkupHtml.
export function decorate(
  el: HTMLElement,
  text: string,
  revealOffset: number | null,
  preserveCaret: boolean,
): void {
  const html = inlineMarkupHtml(text, revealOffset);
  if (renderCache.get(el) === html) return;
  const offset = preserveCaret ? getCaretOffset(el) : -1;
  el.innerHTML = html;
  renderCache.set(el, html);
  if (offset >= 0) setCaretOffset(el, offset);
}

// Absolute count of SOURCE characters before the collapsed caret within `el`. A
// folded link contributes its full `data-src-len` (not its shorter label), so
// the returned offset indexes into node.text -- which is what Enter-split,
// Backspace, arrow nav, and the slash/tag menus all expect.
export function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return 0;
  return sourceOffsetUpTo(el, range.endContainer, range.endOffset);
}

// The collapsed-or-not selection as absolute SOURCE character offsets within
// `el`, `start <= end`. Used by paste to know what range it's replacing.
// Returns null when there's no selection inside `el`.
export function getSelectionRange(
  el: HTMLElement,
): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer))
    return null;
  const start = sourceOffsetUpTo(el, range.startContainer, range.startOffset);
  const end = sourceOffsetUpTo(el, range.endContainer, range.endOffset);
  return { start, end };
}

// Source length of the content from the start of `el` up to the DOM point
// (container, offset). Walks in document order, counting text-node lengths and
// folded-link source lengths, and stops once the point is reached. Handles both
// a text-node caret (container is the text node) and an element caret (container
// is an element, offset is a child index).
function sourceOffsetUpTo(
  el: HTMLElement,
  container: Node,
  offset: number,
): number {
  let total = 0;
  let found = false;
  const visit = (node: Node) => {
    if (found) return;
    if (node.nodeType === 3 /* text */) {
      if (node === container) {
        total += offset;
        found = true;
      } else {
        total += node.textContent?.length ?? 0;
      }
      return;
    }
    if (isFoldedLink(node)) {
      total += foldedSrcLen(node as HTMLElement);
      // Caret can't normally land inside an atomic widget; if it somehow did,
      // snap to just after it.
      if (node === container || node.contains(container)) found = true;
      return;
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (node === container && i === offset) {
        found = true;
        return;
      }
      visit(children[i]!);
      if (found) return;
    }
    if (node === container && offset >= children.length) found = true;
  };
  visit(el);
  return total;
}

// Drop the caret at absolute SOURCE character `offset`, walking nodes until the
// offset falls inside one. A folded link consumes its full source length; an
// offset landing "inside" the atomic token snaps to just after it (or before,
// at offset 0). Past-the-end lands at the very end.
export function setCaretOffset(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = offset;
  let placed = false;
  const visit = (node: Node) => {
    if (placed) return;
    if (node.nodeType === 3 /* text */) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        placed = true;
      } else {
        remaining -= len;
      }
      return;
    }
    if (isFoldedLink(node)) {
      const len = foldedSrcLen(node as HTMLElement);
      if (remaining <= len) {
        placeAtWidget(node as HTMLElement, remaining === 0 ? "before" : "after");
        placed = true;
      } else {
        remaining -= len;
      }
      return;
    }
    node.childNodes.forEach(visit);
  };
  el.childNodes.forEach(visit);
  if (!placed) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// Collapse the selection just before/after an atomic folded-link widget, by
// addressing the position in its parent (the caret never goes inside it).
function placeAtWidget(widget: HTMLElement, side: "before" | "after"): void {
  const sel = window.getSelection();
  const parent = widget.parentNode;
  if (!sel || !parent) return;
  const idx = Array.prototype.indexOf.call(parent.childNodes, widget);
  const range = document.createRange();
  range.setStart(parent, side === "before" ? idx : idx + 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Per-link reveal reflow. While a bullet is focused, watch the caret: as it
// crosses into or out of a link, re-decorate so exactly the link under the
// caret is revealed (and others fold). Cheap by design -- it bails on a
// link-free line, and decorate()'s render cache makes a move within the same
// active link a no-op. `paused` suspends it during IME composition. Returns a
// cleanup to call on blur. See ADR 0017 (per-link reveal).
export function watchCaretReveal(
  el: HTMLElement,
  paused: () => boolean,
): () => void {
  const handler = () => {
    if (paused() || document.activeElement !== el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (!el.contains(sel.getRangeAt(0).endContainer)) return;
    const text = readSource(el);
    if (!text.includes("](")) return; // fast path: no link possible
    decorate(el, text, getCaretOffset(el), true);
  };
  document.addEventListener("selectionchange", handler);
  return () => document.removeEventListener("selectionchange", handler);
}
