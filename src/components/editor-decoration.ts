import { useEffect, useRef, type RefObject } from "react";

import { echoedTextFor } from "../data/collection";
import { getHistoryState } from "../data/history";
import { hasFoldingToken } from "../plugins/registry";
import {
  decorate,
  getCaretOffset,
  readSource,
  revealLinkAtCaret,
  useEditorFeatureDecoration,
  watchCaretReveal,
} from "./inline-code";

/** Mutations and menus remain surface-owned; only the DOM decoration waits for IME. */
export function useInputDecoration(ref: RefObject<HTMLElement | null>) {
  const syncedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  useEditorFeatureDecoration(ref, composingRef);

  function paintInput(el: HTMLElement, text: string) {
    if (composingRef.current) return;
    decorate(el, text, getCaretOffset(el), true);
    syncedRef.current = text;
  }

  return {
    syncedRef,
    composingRef,
    paintInput,
    startComposition() {
      composingRef.current = true;
    },
    endComposition(el: HTMLElement, write: (text: string) => void) {
      composingRef.current = false;
      const text = readSource(el);
      write(text);
      paintInput(el, text);
    },
  };
}

/** Store-to-DOM reconciliation for rows and titles, not Quick-add's live draft. */
export function useStoredTextDecoration({
  ref,
  node,
  syncedRef,
  composingRef,
  keepFocusedPrefix = false,
}: {
  ref: RefObject<HTMLElement | null>;
  node: { id: string; text: string };
  syncedRef: RefObject<string | null>;
  composingRef: RefObject<boolean>;
  /** Preserve the title's existing prefix hold; rows must accept local shrinks. */
  keepFocusedPrefix?: boolean;
}) {
  // Run after every render: focus, history, and composition are not reactive
  // dependencies. A skipped echo must not mark the DOM as synced (ADR 0010).
  useEffect(() => {
    const el = ref.current;
    if (!el || composingRef.current) return;
    if (syncedRef.current === node.text) return;
    const focused = document.activeElement === el;
    if (focused && !getHistoryState().busy) {
      if (echoedTextFor(node.id) === node.text) return;
      if (keepFocusedPrefix) {
        const dom = readSource(el);
        if (dom !== node.text && dom.startsWith(node.text)) return;
      }
    }
    decorate(el, node.text, focused ? getCaretOffset(el) : null, focused);
    syncedRef.current = node.text;
  });
}

/** A focused editor owns one watcher, including when it disconnects without blur. */
export function useCaretReveal(
  composing: RefObject<boolean>,
  synced: RefObject<string | null>,
) {
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      dispose.current?.();
      dispose.current = null;
    };
  }, []);

  return {
    focus(el: HTMLElement, text: string) {
      dispose.current?.();
      dispose.current = watchCaretReveal(el, () => composing.current);
      if (!hasFoldingToken(text)) return;
      // Re-read source at frame time, after the browser settles the click caret.
      revealLinkAtCaret(el, (source) => {
        synced.current = source;
      });
    },
    blur() {
      dispose.current?.();
      dispose.current = null;
    },
  };
}
