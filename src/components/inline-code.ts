// Shared inline decoration for contentEditable bullet/title text. The tokens
// themselves (`code` runs, #tags, rich links) are PLUGIN-CONTRIBUTED (ADR 0001):
// each registers a regex fragment + a declarative `render` in src/plugins/, and
// the registry composes them into one combined regex + dispatch (registry.ts).
// This file owns only the generic machinery -- the one decorate pass, escaping
// + serialization, and the source-offset caret math -- with no per-token branch.
//
// Both the outline bullets (OutlineNode) and the zoomed page title
// (OutlineEditor's ZoomedTitle) render their stored markdown as live HTML:
// the contentEditable always holds formatted output (mono chips, tag chips,
// folded links), and each keystroke re-tokenizes the line and rebuilds its DOM.
// The caret is saved as an absolute SOURCE-character offset before the rebuild
// and restored after.
//
// A #tag keeps its FULL source visible (the leading `#`), so its source string
// and rendered text have identical length. FOLDING tokens (links, inline code,
// emphasis) are the exception: each folds to a shorter atomic widget unless the
// caret is within/adjacent, when it reveals its markers as real, walk-through
// text -- a link's `[label](✎)` (ADR 0005's bracket reveal, only the bare url
// stays an atom), or code/emphasis's dimmed `` ` ``/`*` markers flanking the
// styled run (ADR 0025). An atom carries its full source in `data-src` (+
// `data-src-len`) and `contenteditable="false"`; the caret helpers below count
// it off `data-src` generically, so every consumer keeps speaking source
// offsets -- with no per-token special-casing (the unlock in ADR 0001 D6).

import { hasFoldingToken, renderToken, tokenRegex } from "../plugins/registry";
import { WIDGET_TAG } from "./plugin-widget";
import type { El, WidgetEl } from "../plugins/types";

/** True for a widget descriptor (Seam A's React mode -- ADR 0006) vs an `El`. */
function isWidgetEl(el: El | WidgetEl): el is WidgetEl {
  return typeof el === "object" && (el as WidgetEl).kind === "widget";
}

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
// source visible in both states. See ADR 0005 (per-link reveal).
function inlineMarkupHtml(
  text: string,
  revealOffset: number | null,
): string {
  let html = "";
  let last = 0;
  for (const m of text.matchAll(tokenRegex)) {
    const start = m.index ?? 0;
    const tok = m[0];
    const end = start + tok.length;
    html += escapeHtml(text.slice(last, start));
    // The plugin that owns this token returns a declarative descriptor; the
    // core escapes + serializes it, so a plugin never hands us raw HTML (D6).
    html += serializeEl(renderToken(m, { revealOffset, start, end }));
    last = end;
  }
  html += escapeHtml(text.slice(last));
  return html;
}

// Serialize a plugin's element descriptor (El) into the contentEditable HTML
// string. The core owns escaping: text children are HTML-escaped, attribute
// values are attr-escaped, `true` is a bare boolean attribute, and
// `false`/`undefined` drop the attribute. Insertion order is preserved so the
// generated HTML stays stable (the render cache compares strings).
function serializeEl(el: El | WidgetEl): string {
  if (typeof el === "string") return escapeHtml(el);
  if (isWidgetEl(el)) return serializeWidget(el);
  let out = `<${el.tag}`;
  if (el.attrs) {
    for (const [name, value] of Object.entries(el.attrs)) {
      if (value === false || value == null) continue;
      if (value === true) out += ` ${name}`;
      else out += ` ${name}="${escapeAttr(String(value))}"`;
    }
  }
  out += ">";
  if (el.children) for (const child of el.children) out += serializeEl(child);
  out += `</${el.tag}>`;
  return out;
}

// Serialize a widget descriptor to the `<dotflowy-widget>` atom (ADR 0006). The
// core owns the atom contract -- `data-src` (+ `data-src-len`) and
// `contenteditable="false"` make `readSource`/the caret math treat it as one
// opaque unit (isAtom keys on `data-src`), exactly like a folded link. The
// component mounts later, when plugin-widget upgrades the element by its
// `data-widget` id; `props` ride along as JSON in `data-props`. The atom's text
// child is the raw source -- a graceful pre-mount fallback that React replaces.
// The string is deterministic (stable attr order, JSON of an insertion-ordered
// props object) so the render cache still skips an unchanged rebuild.
function serializeWidget(w: WidgetEl): string {
  let out = `<${WIDGET_TAG} data-widget="${escapeAttr(w.widget ?? "")}"`;
  out += ` data-src="${escapeAttr(w.source)}"`;
  out += ` data-src-len="${w.source.length}"`;
  out += ` contenteditable="false"`;
  if (w.props && Object.keys(w.props).length > 0) {
    out += ` data-props="${escapeAttr(JSON.stringify(w.props))}"`;
  }
  if (w.attrs) {
    for (const [name, value] of Object.entries(w.attrs)) {
      if (value === false || value == null) continue;
      if (value === true) out += ` ${name}`;
      else out += ` ${name}="${escapeAttr(String(value))}"`;
    }
  }
  out += `>${escapeHtml(w.source)}</${WIDGET_TAG}>`;
  return out;
}

// Quote/angle-bracket-safe attribute value for the link href + data-src (they
// can carry arbitrary chars; encodeUrlForMarkdown only handles `( ) space`).
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// True for an ATOMIC folding-token widget -- any element carrying its full
// source in `data-src` (a folded link, code, or emphasis run). Keyed on
// `data-src` alone, not on "link", so the caret math is generic over folding
// tokens (ADR 0001 D6). Non-folding tokens (#tags), a revealed run's markers,
// and revealed links carry no data-src, so they read back 1:1 as plain text.
function isAtom(node: Node): node is HTMLElement {
  return node.nodeType === 1 && (node as HTMLElement).hasAttribute("data-src");
}

function foldedSrcLen(el: HTMLElement): number {
  const n = Number(el.getAttribute("data-src-len"));
  return Number.isFinite(n) && n > 0
    ? n
    : (el.getAttribute("data-src") ?? "").length;
}

// Reconstruct the markdown SOURCE from the live DOM. el.textContent is no longer
// the source once a folding token hides part of its source (a folded link shows
// only its label; folded code/emphasis hide their markers), so
// onInput/onCompositionEnd/paste read through this instead: walk the tree
// emitting `data-src` for atoms (folded links/code/emphasis, a revealed link's
// url chip) and textContent for everything else (a revealed run's markers +
// interior, and #tags, are all 1:1 with their source). See ADR 0005 / ADR 0025.
export function readSource(el: HTMLElement): string {
  let out = "";
  const visit = (node: Node) => {
    if (node.nodeType === 3 /* text */) {
      out += node.textContent ?? "";
      return;
    }
    if (isAtom(node)) {
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
    if (isAtom(node)) {
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
    if (isAtom(node)) {
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
// cleanup to call on blur. See ADR 0005 (per-link reveal).
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
    if (!hasFoldingToken(text)) return; // fast path: nothing here can reveal
    decorate(el, text, getCaretOffset(el), true);
  };
  document.addEventListener("selectionchange", handler);
  return () => document.removeEventListener("selectionchange", handler);
}

// Reveal the link under the caret on the NEXT animation frame, not synchronously.
// On a mouse click, focus fires before the browser finalizes the click caret; a
// synchronous reveal would expand the folded link under the pointer first, so a
// click at the visual END of the line then lands geometrically in the MIDDLE of
// the now-longer markdown. Deferring lets the click settle against the folded
// layout (caret at the true end); we then re-read the source offset, reveal, and
// restore the caret. No-op if focus left before the frame. The selectionchange
// watcher already covers a click; this is the belt for a focus that emits no
// selectionchange (e.g. a programmatic el.focus()). See ADR 0005.
//
// The text is re-read from the DOM AT FRAME TIME (readSource), never captured
// at focus time: a synchronous edit landing between the focus and the frame
// (a cut, a paste) would otherwise be repainted over with the stale snapshot.
// `onRevealed` receives the text that was actually rendered.
export function revealLinkAtCaret(
  el: HTMLElement,
  onRevealed?: (text: string) => void,
): void {
  requestAnimationFrame(() => {
    if (document.activeElement !== el) return;
    const text = readSource(el);
    const caret = getCaretOffset(el);
    decorate(el, text, caret, false);
    onRevealed?.(text);
    setCaretOffset(el, caret);
  });
}
