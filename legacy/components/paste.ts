// Core paste handling for bullets and the zoomed title (Seam I, ADR 0018). The
// browser's default contentEditable paste injects arbitrary rich HTML, which
// breaks the "the DOM is always rebuilt from plain-text source" model. So we
// ALWAYS preventDefault and insert plain text ourselves -- then let plugins
// layer richer behavior on top by deciding WHAT string to insert.
//
// The core owns the mechanics (read source + selection, splice, re-decorate,
// place caret) and the plain-text baseline; each plugin's `input.onPaste`
// (registry.pasteReplacement) gets first say on the replacement string. The
// links plugin contributes the URL/anchor cases (src/plugins/links); with no
// plugin claiming it, paste is plain text with formatting stripped.
//
// A focused bullet is shown with the link under the caret REVEALED (raw), and
// readSource reconstructs the literal markdown from the DOM regardless -- so we
// splice into source space directly, then re-decorate.

import type { ClipboardEvent } from "react";
import { pasteReplacement } from "../plugins/registry";
import {
  decorate,
  getSelectionRange,
  readSource,
  setCaretOffset,
} from "./inline-code";

/**
 * Handle a paste into a (focused) contentEditable bullet/title. Returns the new
 * source text on success (so the caller can update its synced-text ref), or
 * null if there was no clipboard to read.
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
  const range = getSelectionRange(el) ?? {
    start: source.length,
    end: source.length,
  };
  const { start, end } = range;
  const selectedText = source.slice(start, end);
  const hasSelection = end > start;

  // A plugin decides the replacement (e.g. the links plugin wraps a selection
  // or auto-links a URL); otherwise plain text, formatting stripped (bullets
  // are single-line, so newlines collapse to spaces -- no tree-from-paste v1).
  const replacement = pasteReplacement({
    plain,
    html,
    selectedText,
    hasSelection,
  });
  const inserted = replacement ?? plain.replace(/\r?\n/g, " ");

  const next = source.slice(0, start) + inserted + source.slice(end);
  const caret = start + inserted.length;
  onText(next);
  // Caret lands right after the insert; revealing whatever link it's now on
  // (a just-pasted link shows raw until the user clicks away). See ADR 0017.
  decorate(el, next, caret, false);
  setCaretOffset(el, caret);
  return next;
}
