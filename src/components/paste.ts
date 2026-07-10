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
import { afterPaste, pasteReplacement } from "../plugins/registry";
import type { PluginContext } from "../plugins/types";
import type { MdPastePlacement } from "../data/markdown-import";
import {
  decorate,
  getSelectionRange,
  readSource,
  setCaretOffset,
} from "./inline-code";
import { pasteMarkdownTree, type PasteFocusSink } from "./markdown-paste";

// --- Mod+Shift+V: paste literal (ADR 0044) ------------------------------------
// The `paste` event exposes `clipboardData`, never the modifier keys that
// produced it. The keystroke's `keydown` always fires first (the paste event is
// the browser's *response* to it), so we arm a flag there and read it in the
// paste that follows -- ProseMirror's shipped technique, not a hopeful one.
// Armed on the way down, disarmed on the way back up, so a stray later paste
// (context menu, another Cmd+V) can never inherit it.

let literalArmed = false;

/** Whether the paste now firing came from `Mod+Shift+V`. One-shot. */
function consumeLiteralArm(): boolean {
  const armed = literalArmed;
  literalArmed = false;
  return armed;
}

/**
 * Watch for the literal-paste chord anywhere in the document (both bullets and
 * the zoomed title paste, so a window listener beats three element ones).
 * Capture phase, so an editor keymap that stops propagation can't disarm it.
 * Call once; returns the disposer.
 */
export function installLiteralPasteArm(): () => void {
  const down = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "v" || e.key === "V")) {
      literalArmed = true;
    }
  };
  const up = () => {
    literalArmed = false;
  };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    literalArmed = false;
  };
}

/** Where a structural (multi-line) paste lands, supplied by the call site. The
 *  zoomed title is the exception the two-render-paths trap punishes: its
 *  siblings live outside the view, so remaining roots become its children. */
export interface StructuralPasteTarget {
  placement: MdPastePlacement;
  /** The row key being edited (mirror-aware focus); equals the node id off-flag. */
  activeKey: string;
  rowEl: Element | null;
  focus: PasteFocusSink;
}

/**
 * Handle a paste into a (focused) contentEditable bullet/title. Returns the new
 * source text on success (so the caller can update its synced-text ref), or
 * null if there was no clipboard to read.
 *
 * `nodeId` + `getCtx` let plugins run a post-paste side effect (Seam I's
 * `afterPaste`, ADR 0016) -- e.g. the links plugin fetching a pasted URL's title
 * and swapping it into the label. `getCtx` is the same stable PluginContext
 * factory used everywhere; it's only called when a paste actually happened.
 */
export function pasteIntoBullet(
  e: ClipboardEvent<HTMLElement>,
  el: HTMLElement,
  nodeId: string,
  getCtx: () => PluginContext,
  onText: (text: string) => void,
  structural: StructuralPasteTarget | null = null,
): string | null {
  const cd = e.clipboardData;
  if (!cd) return null;
  e.preventDefault();

  const literal = consumeLiteralArm();
  // A single trailing newline terminates the last line; it does not add an empty
  // one. So a URL copied out of a terminal ("https://x.com\n") stays a SINGLE-
  // line paste and keeps the links plugin's wrap + unfurl (Seam I).
  const plain = cd.getData("text/plain").replace(/\r\n?/g, "\n").replace(/\n$/, "");
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

  // Multi-line paste is ALWAYS structural (ADR 0044) -- no content sniffing.
  // Today's fallback (join with spaces) is itself lossy: the line breaks are
  // destroyed and unrecoverable, so the conservative-looking branch is the
  // destructive one. Splitting a joined paragraph back apart is retyping;
  // merging two bullets is one Backspace. The core pre-pass runs BEFORE the
  // Seam I chain and never returns to it.
  if (structural && plain.includes("\n")) {
    const handled = pasteMarkdownTree({
      source: plain,
      literal,
      anchorId: nodeId,
      activeKey: structural.activeKey,
      placement: structural.placement,
      head: source.slice(0, start),
      tail: source.slice(end),
      rowEl: structural.rowEl,
      focus: structural.focus,
    });
    // The collection now owns the anchor's text; the row's sync effect
    // re-decorates from it. Reporting null keeps the caller's `syncedRef` stale,
    // which is exactly what makes that effect fire.
    if (handled) return null;
  }

  // A plugin decides the replacement (e.g. the links plugin wraps a selection
  // or auto-links a URL); otherwise plain text, formatting stripped. `literal`
  // skips the chain entirely -- a "literal" paste that still chips your URL is a
  // broken promise, and a modifier whose meaning depends on the line count is a
  // cliff (ADR 0044).
  const replacement = literal
    ? null
    : pasteReplacement({ plain, html, selectedText, hasSelection });
  const inserted = replacement ?? plain.replace(/\n/g, " ");

  const next = source.slice(0, start) + inserted + source.slice(end);
  const caret = start + inserted.length;
  onText(next);
  // Caret lands right after the insert; revealing whatever link it's now on
  // (a just-pasted link shows raw until the user clicks away). See ADR 0005.
  decorate(el, next, caret, false);
  setCaretOffset(el, caret);
  // Post-paste side effects, now that the DOM reflects the insert (so a plugin
  // can decorate the just-folded link). Plugins self-gate on the inserted text.
  // Literal paste means literal: no unfurl fetch either.
  if (!literal) afterPaste({ inserted, nodeId, el }, getCtx());
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
