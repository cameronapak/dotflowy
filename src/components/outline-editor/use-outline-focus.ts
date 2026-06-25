import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { TreeIndex } from "../../data/tree";
import { redo, undo } from "../../data/history";
import { flashRow } from "../flash-node";
import { placeCaretAtEnd, placeCaretAtStart } from "./caret";

export interface OutlineFocus {
  /** id -> contentEditable span. The zoomed title registers under rootId too,
   *  so focus logic treats titles and list items uniformly. */
  refs: RefObject<Map<string, HTMLSpanElement | null>>;
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  /** The node to focus after the next render (most-recently inserted/moved). */
  pendingFocus: RefObject<string | null>;
  /** When an Enter-split moved text into the new bullet, land the caret at its
   *  START, not its end (every other pending-focus wants the end). */
  pendingFocusAtStart: RefObject<boolean>;
  /** Like pendingFocus, but pulses the row's background to mark a just-moved
   *  node (set after a drag/keyboard move). */
  pendingFlash: RefObject<string | null>;
}

/**
 * Focus plumbing for the editor: the id->span registry, the after-render focus/
 * flash pass, and undo/redo (which restore focus to the node the undone action
 * left it on). Split out of OutlineEditor so the body stays readable; the refs
 * are returned so the command closures and drag can write them. See ADR 0014.
 */
export function useOutlineFocus(
  focusIndex: RefObject<TreeIndex>,
): OutlineFocus {
  // The refs registry. Lazy-init the Map once: useRef has no lazy-initializer
  // form, so passing `new Map()` directly would rebuild and discard it on every
  // render. (react-doctor/rerender-lazy-ref-init.)
  const refs = useRef<Map<string, HTMLSpanElement | null>>(null!);
  if (!refs.current) refs.current = new Map();
  const registerRef = useCallback((id: string, el: HTMLSpanElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);

  const pendingFocus = useRef<string | null>(null);
  const pendingFocusAtStart = useRef(false);
  const pendingFlash = useRef<string | null>(null);

  // After every render, if a focus is pending and the target exists, focus it;
  // likewise flash a just-moved row. Both run post-render because the target row
  // only exists after the structural mutation's render.
  useEffect(() => {
    if (pendingFocus.current) {
      const el = refs.current.get(pendingFocus.current);
      if (el) {
        el.focus();
        if (pendingFocusAtStart.current) placeCaretAtStart(el);
        else placeCaretAtEnd(el);
      }
      pendingFocus.current = null;
      pendingFocusAtStart.current = false;
    }
    if (pendingFlash.current) {
      const el = refs.current.get(pendingFlash.current);
      flashRow(el?.closest(".outline-row") ?? null);
      pendingFlash.current = null;
    }
  });

  // The currently-focused bullet id, by reverse-looking-up the registry (covers
  // list items and the zoomed title). Null when focus is outside the outline.
  const findFocusedId = useCallback((): string | null => {
    const active = document.activeElement;
    for (const [id, el] of refs.current) {
      if (el === active) return id;
    }
    return null;
  }, []);

  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z: undo/redo, owning history over the browser's
  // native contentEditable undo (preventDefault). The focused id is handed in so
  // redo can return focus where the action left it; the restored id becomes the
  // next pending focus.
  useHotkey(
    "Mod+Z",
    () => {
      const focusId = undo(focusIndex.current, findFocusedId());
      if (focusId) pendingFocus.current = focusId;
    },
    { preventDefault: true },
  );
  useHotkey(
    "Mod+Shift+Z",
    () => {
      const focusId = redo(focusIndex.current, findFocusedId());
      if (focusId) pendingFocus.current = focusId;
    },
    { preventDefault: true },
  );

  return { refs, registerRef, pendingFocus, pendingFocusAtStart, pendingFlash };
}
