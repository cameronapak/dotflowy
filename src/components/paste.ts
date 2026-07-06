// Core paste handling for bullets and the zoomed title (Seam I, ADR 0001). The
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
import {
  normalizeDepths,
  parseMarkdownPaste,
  type ParsedItem,
} from "../data/markdown-paste";
import { afterPaste, pasteReplacement } from "../plugins/registry";
import type { PluginContext } from "../plugins/types";
import {
  decorate,
  getSelectionRange,
  readSource,
  setCaretOffset,
} from "./inline-code";

/**
 * When a multi-line paste is detected (and no plugin claimed it), this callback
 * is invoked with all parsed items. The first item has already been written into
 * the current bullet; the handler creates the remaining siblings/children.
 * Returns the id of the last created bullet (for focus), or null to signal
 * "no structural insert happened".
 */
export type MultiLinePasteHandler = (items: ParsedItem[]) => string | null;

/**
 * Handle a paste into a (focused) contentEditable bullet/title. Returns the new
 * source text on success (so the caller can update its synced-text ref), or
 * null if there was no clipboard to read.
 *
 * `nodeId` + `getCtx` let plugins run a post-paste side effect (Seam I's
 * `afterPaste`, ADR 0016) -- e.g. the links plugin fetching a pasted URL's title
 * and swapping it into the label. `getCtx` is the same stable PluginContext
 * factory used everywhere; it's only called when a paste actually happened.
 *
 * `onMultiLine` (optional) handles multi-line pastes (e.g. a markdown list from
 * Obsidian). When provided and the paste spans multiple lines, it creates real
 * sibling bullets via runStructural and returns the last id (for focus).
 */
export function pasteIntoBullet(
  e: ClipboardEvent<HTMLElement>,
  el: HTMLElement,
  nodeId: string,
  getCtx: () => PluginContext,
  onText: (text: string) => void,
  onMultiLine?: MultiLinePasteHandler,
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
  // or auto-links a URL). If a plugin claims it, we use that string and skip
  // multi-line parsing (a pasted URL is single-purpose).
  const replacement = pasteReplacement({
    plain,
    html,
    selectedText,
    hasSelection,
  });

  // Multi-line paste: parse markdown list syntax into items and hand off to the
  // editor's structural handler (creates real sibling/child bullets). Only when
  // no plugin claimed the paste and a handler was provided.
  if (!replacement && onMultiLine) {
    const items = parseMarkdownPaste(plain);
    if (items && items.length > 0) {
      normalizeDepths(items);
      const [first, ...rest] = items;
      const firstText = first!.text;
      // Write the first line into the current bullet (replacing the selection).
      const next = source.slice(0, start) + firstText + source.slice(end);
      onText(next);
      decorate(el, next, start + firstText.length, false);
      setCaretOffset(el, start + firstText.length);
      // Fire afterPaste for the first line (e.g. a URL title unfurl).
      afterPaste({ inserted: firstText, nodeId, el }, getCtx());
      // Create the remaining bullets; the handler owns focus, and the
      // synced-text ref update from `next` is the caller's job.
      onMultiLine([first!, ...rest]);
      return next;
    }
  }

  const inserted = replacement ?? plain.replace(/\r?\n/g, " ");

  const next = source.slice(0, start) + inserted + source.slice(end);
  const caret = start + inserted.length;
  onText(next);
  // Caret lands right after the insert; revealing whatever link it's now on
  // (a just-pasted link shows raw until the user clicks away). See ADR 0005.
  decorate(el, next, caret, false);
  setCaretOffset(el, caret);
  // Post-paste side effects, now that the DOM reflects the insert (so a plugin
  // can decorate the just-folded link). Plugins self-gate on the inserted text.
  afterPaste({ inserted, nodeId, el }, getCtx());
  return next;
}

/**
 * Copy the selected SOURCE (not the rendered text) to the clipboard. A folded
 * link renders only its label, so the browser's native copy would drop the
 * `(url)` half; this writes the source slice instead -- "whatever you copy
 * comes back as markdown" (ADR 0005). Returns the source + selection range on
 * success, or null when there's no selection inside `el` (native copy
 * proceeds; on a link-free line source == rendered text anyway).
 */
export function copySourceSelection(
  e: ClipboardEvent<HTMLElement>,
  el: HTMLElement,
): { source: string; start: number; end: number } | null {
  const cd = e.clipboardData;
  if (!cd) return null;
  const range = getSelectionRange(el);
  if (!range || range.end <= range.start) return null;
  const source = readSource(el);
  e.preventDefault();
  cd.setData("text/plain", source.slice(range.start, range.end));
  return { source, ...range };
}

/**
 * Cut = the same source copy plus the source-space delete (the native cut
 * would both copy the rendered text AND leave the DOM for the browser to
 * mangle). Splices in source space like a paste, re-decorates, and drops the
 * caret at the cut point. Returns the new source text (so the caller can
 * update its synced-text ref), or null when nothing was cut.
 */
export function cutSourceSelection(
  e: ClipboardEvent<HTMLElement>,
  el: HTMLElement,
  onText: (text: string) => void,
): string | null {
  const cut = copySourceSelection(e, el);
  if (!cut) return null;
  const next = cut.source.slice(0, cut.start) + cut.source.slice(cut.end);
  onText(next);
  decorate(el, next, cut.start, false);
  // Restore the caret only when the bullet already owns focus. Placing a
  // selection into an UNFOCUSED contentEditable focuses it (Chromium), and the
  // resulting onFocus reveal would repaint this bullet from its pre-cut render
  // scope -- resurrecting the text we just cut.
  if (document.activeElement === el) setCaretOffset(el, cut.start);
  return next;
}
