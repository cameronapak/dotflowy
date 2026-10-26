import { useEffect, useRef, type RefObject } from "react";

import { hasFoldingToken } from "../plugins/registry";
import { revealLinkAtCaret, watchCaretReveal } from "./inline-code";

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
