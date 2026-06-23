// Paste handling for bullets and the zoomed title (ADR 0017). The browser's
// default contentEditable paste injects arbitrary rich HTML, which breaks the
// "the DOM is always rebuilt from plain-text source" model. So we ALWAYS
// preventDefault and insert plain text ourselves -- with three link-aware
// special cases layered on top:
//
//  1. selection + clipboard is a bare URL  -> wrap the selection as a link
//  2. collapsed + clipboard is a rich link -> insert `[title](url)`
//  3. collapsed + clipboard is a bare URL  -> auto-link it
//  otherwise                               -> plain text, formatting stripped
//
// A focused bullet is always shown REVEALED (raw), so `el.textContent` is the
// literal markdown source -- we splice into it directly, then re-decorate.

import type { ClipboardEvent } from "react";
import { bareHttpUrl, encodeUrlForMarkdown, isHttpUrl } from "../data/links";
import {
  decorate,
  getSelectionRange,
  readSource,
  setCaretOffset,
} from "./inline-code";

/**
 * Handle a paste into a (focused, revealed) contentEditable bullet/title.
 * Returns the new source text on success (so the caller can update its
 * synced-text ref), or null if it declined to handle the event.
 */
export function pasteIntoBullet(
  e: ClipboardEvent<HTMLElement>,
  el: HTMLElement,
  onText: (text: string) => void,
): string | null {
  const cd = e.clipboardData;
  if (!cd) return null;
  e.preventDefault();

  const plain = cd.getData("text/plain");
  const html = cd.getData("text/html");

  // readSource reconstructs the raw markdown from the DOM (a focused bullet can
  // hold folded links whose label != source); getSelectionRange returns source
  // offsets, so the splice below operates entirely in source space.
  const source = readSource(el);
  const range = getSelectionRange(el) ?? { start: source.length, end: source.length };
  const { start, end } = range;
  const selectedText = source.slice(start, end);
  const hasSelection = end > start;

  let inserted: string;
  const selUrl = bareHttpUrl(plain);
  const anchor = hasSelection ? null : singleAnchor(html);

  if (hasSelection && selUrl) {
    // (1) wrap the selection
    inserted = `[${selectedText}](${encodeUrlForMarkdown(selUrl)})`;
  } else if (anchor) {
    // (2) rich link, nothing selected
    inserted = `[${anchor.text}](${encodeUrlForMarkdown(anchor.href)})`;
  } else if (!hasSelection && selUrl) {
    // (3) bare URL auto-link
    inserted = `[${selUrl}](${encodeUrlForMarkdown(selUrl)})`;
  } else {
    // plain text, formatting stripped; bullets are single-line so newlines
    // collapse to spaces (no tree-from-paste in v1).
    inserted = plain.replace(/\r?\n/g, " ");
  }

  const next = source.slice(0, start) + inserted + source.slice(end);
  const caret = start + inserted.length;
  onText(next);
  // Caret lands right after the insert; revealing whatever link it's now on
  // (the just-pasted one shows raw until the user clicks away). See ADR 0017.
  decorate(el, next, caret, false);
  setCaretOffset(el, caret);
  return next;
}

/**
 * If the clipboard HTML is "essentially a single anchor" -- exactly one
 * `<a href>` whose text is the whole payload -- return its text + http(s) href.
 * Anything richer (a paragraph, multiple links, a table) returns null and falls
 * back to plain text. Narrow on purpose (ADR 0017).
 */
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
