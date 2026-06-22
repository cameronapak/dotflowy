// Shared inline-`code` decoration for contentEditable bullet/title text.
//
// Both the outline bullets (OutlineNode) and the zoomed page title
// (OutlineEditor's ZoomedTitle) render their stored markdown as live HTML:
// the contentEditable always holds formatted output (mono chips), and each
// keystroke re-tokenizes the line and rebuilds its DOM. The caret is saved as
// an absolute character offset before the rebuild and restored after.
//
// Backticks are kept VISIBLE inside the chip so the source string and the
// rendered text have identical length -- caret offsets need no source<->display
// mapping. The stored text is always the raw markdown.

// Inline `code` runs: `like this`. Single-line, non-empty, no nested backtick.
const INLINE_CODE = /`[^`\n]+`/g;

const CODE_CLASS =
  "rounded-[4px] border border-border/60 bg-muted px-0.5 py-0.5 font-mono text-[0.85em] text-foreground";

// Build the display HTML for a line of text. Escapes first (user input going
// into innerHTML), then wraps inline-code runs. We wrap the WHOLE match --
// backticks included -- so the chip's text length equals the source's; that's
// what lets the caret-offset save/restore work without mapping source positions
// to display positions. Backticks aren't escaped, so they survive escaping and
// the regex still matches the already-escaped text.
export function inlineMarkupHtml(text: string): string {
  return escapeHtml(text).replace(
    INLINE_CODE,
    (match) => `<code class="${CODE_CLASS}">${match}</code>`,
  );
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
