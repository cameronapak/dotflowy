import { useEffect, useRef, type RefObject } from "react";

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
