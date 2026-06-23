// Shared inline decoration for contentEditable bullet/title text: `code` runs
// and #tags.
//
// Both the outline bullets (OutlineNode) and the zoomed page title
// (OutlineEditor's ZoomedTitle) render their stored markdown as live HTML:
// the contentEditable always holds formatted output (mono chips, tag chips),
// and each keystroke re-tokenizes the line and rebuilds its DOM. The caret is
// saved as an absolute character offset before the rebuild and restored after.
//
// The chip text keeps the FULL source run (backticks for code, the leading `#`
// for tags), so the source string and the rendered text have identical length
// -- caret offsets need no source<->display mapping. The stored text is always
// the raw markdown. See docs/adr/0015 for tags.

import { TAG_PATTERN } from "../data/tags";

// Inline `code` runs: `like this`. Single-line, non-empty, no nested backtick.
const CODE_RUN = "`[^`\\n]+`";

// One pass over code runs and tags, in document order. Code is listed first so
// a `#tag` *inside* a code run (e.g. `#define`) stays code, never a tag chip.
const TOKEN = new RegExp(`${CODE_RUN}|${TAG_PATTERN}`, "gu");

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

// Build the display HTML for a line of text. Walks code/tag tokens in order,
// escaping the plain text between them (user input going into innerHTML) and
// wrapping each token. We wrap the WHOLE match -- backticks / leading `#`
// included -- so each chip's text length equals its source's; that's what lets
// the caret-offset save/restore work without mapping source positions to
// display positions. A tag's name is `[\p{L}\p{N}_-]+`, so it never contains a
// quote / angle bracket / ampersand and is safe as a bare attribute value.
export function inlineMarkupHtml(text: string): string {
  let html = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const tok = m[0];
    html += escapeHtml(text.slice(last, start));
    if (tok.charCodeAt(0) === 96 /* backtick */) {
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Re-render `el` as formatted HTML, optionally keeping the caret put. The DOM
// rebuild invalidates any (node, offset) selection, so we capture the caret as
// an absolute character offset first and re-derive it against the new tree
// after. Writing innerHTML only when it actually changes avoids needless
// rebuilds (and the caret flicker they cause) when text is already current.
export function decorate(
  el: HTMLElement,
  text: string,
  preserveCaret: boolean,
): void {
  const html = inlineMarkupHtml(text);
  if (el.innerHTML === html) return;
  const offset = preserveCaret ? getCaretOffset(el) : -1;
  el.innerHTML = html;
  if (offset >= 0) setCaretOffset(el, offset);
}

// Absolute count of characters before the collapsed caret within `el`, across
// all text nodes (so a `<code>` chip in the middle is counted transparently).
export function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

// Drop the caret at absolute character `offset`, walking text nodes until the
// offset falls inside one. Past-the-end lands at the very end.
function setCaretOffset(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode();
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}
