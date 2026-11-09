// Backspace at or inside a quote's `> ` marker removes the whole marker
// (ADR 0079). Without this, Backspace after the revealed marker deletes only the
// space, leaving a literal `>` on a plain bullet. Offset 0 is included for the
// task-demotion reason: the first Backspace at the start of a quote unquotes it
// rather than joining it into the row above (ADR 0059).
//
// One decision for all three render paths: rows call it from their Backspace
// listener in `useBulletKeymap`; the zoomed title and Quick-add bind it with
// `useQuoteMarkerBackspace`.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { isQuoteText, QUOTE_MARKER, stripQuoteMarker } from "../data/quote";
import {
  decorate,
  getCaretOffset,
  readSource,
  setCaretOffset,
} from "./inline-code";

/** Unquote `el` when the caret is collapsed at offset 0 to 2 of a quote.
 *  Returns true when it handled the event. */
export function removeQuoteMarkerOnBackspace(
  el: HTMLElement,
  e: Event,
  write: (text: string) => void,
): boolean {
  // A locked row stays focusable but not editable; leave it to the protection
  // guard rather than repainting text the write will refuse.
  if (
    e.defaultPrevented ||
    !e.cancelable ||
    !el.isContentEditable ||
    document.activeElement !== el
  )
    return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  if (!el.contains(sel.getRangeAt(0).startContainer)) return false;
  const text = readSource(el);
  if (!isQuoteText(text) || getCaretOffset(el) > QUOTE_MARKER.length)
    return false;
  e.preventDefault();
  e.stopPropagation();
  const next = stripQuoteMarker(text);
  write(next);
  decorate(el, next, 0, false);
  setCaretOffset(el, 0);
  return true;
}

/** Enter on an empty quote unquotes it in place instead of adding a row, the
 *  way Enter on an empty list item ends a list. An in-place text edit, like
 *  the Backspace rule, so keys typed right after it land in the same row.
 *  Returns true when it handled the Enter. */
export function exitEmptyQuoteOnEnter(
  el: HTMLElement,
  write: (text: string) => void,
): boolean {
  if (!el.isContentEditable || readSource(el) !== QUOTE_MARKER) return false;
  write("");
  decorate(el, "", 0, false);
  setCaretOffset(el, 0);
  return true;
}

/** A plain, unmodified Backspace or a software keyboard's backward delete. */
export function isBackspaceIntent(e: Event): boolean {
  if (e instanceof KeyboardEvent)
    return (
      e.key === "Backspace" &&
      !e.isComposing &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    );
  return (
    e instanceof InputEvent &&
    e.inputType === "deleteContentBackward" &&
    !e.isComposing
  );
}

/** Bind the rule on an editor without its own Backspace listener. */
export function useQuoteMarkerBackspace(
  ref: RefObject<HTMLElement | null>,
  write: (text: string) => void,
) {
  const writeRef = useRef(write);
  useEffect(() => {
    writeRef.current = write;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handle = (e: Event) => {
      if (isBackspaceIntent(e))
        removeQuoteMarkerOnBackspace(el, e, writeRef.current);
    };
    el.addEventListener("keydown", handle, true);
    el.addEventListener("beforeinput", handle);
    return () => {
      el.removeEventListener("keydown", handle, true);
      el.removeEventListener("beforeinput", handle);
    };
  }, [ref]);
}
