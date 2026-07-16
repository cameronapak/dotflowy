import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * The shared active-item behavior for the two caret menus -- `SlashMenuList`
 * (the `/` palette) and `MenuList` (the `#` / `[[` pickers). Both render a
 * `max-h-72 scroll-fade overflow-y-auto` list driven by an `activeIndex` the
 * parent owns, so both need the same two things:
 *
 * 1. **Follow the highlight.** Keyboard nav walks past the visible window, so
 *    the active item is scrolled into view. Pair with `scroll-my-10` on the
 *    item: `block: "nearest"` parks it flush against the container edge, which
 *    is exactly where the `scroll-fade` mask is strongest, and the highlight
 *    would render dimmed.
 * 2. **Don't let the scroll steal the highlight.** Scrolling in (1) slides a
 *    new item under a stationary cursor, and the browser fires hover events for
 *    it -- so plain `onMouseEnter` would snap `activeIndex` back to wherever the
 *    mouse happens to sit, fighting the arrow key. `onItemPointerMove` only
 *    hovers when the pointer's client coords ACTUALLY changed (a scroll-induced
 *    move repeats the last coords), which is how cmdk and Radix draw the line.
 */
export function useMenuActiveItem({
  activeIndex,
  itemCount,
  onHover,
}: {
  activeIndex: number;
  /** A dep of the scroll effect: a refiltered list can leave the container
   *  scrolled while `activeIndex` stays put. */
  itemCount: number;
  onHover: (index: number) => void;
}) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, itemCount]);

  return {
    /** Spread onto each option: attaches the ref to the active one only. */
    itemRef: (i: number) => (i === activeIndex ? activeItemRef : null),
    onItemPointerMove: (i: number) => (e: ReactPointerEvent<HTMLElement>) => {
      const prev = lastPointer.current;
      const moved = !prev || prev.x !== e.clientX || prev.y !== e.clientY;
      // Track every move, including ones we ignore below -- else a later
      // scroll-induced event would compare against stale coords and read as real.
      lastPointer.current = { x: e.clientX, y: e.clientY };
      if (!moved || i === activeIndex) return;
      onHover(i);
    },
  };
}
