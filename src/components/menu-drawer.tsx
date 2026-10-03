import { useEffect, type ComponentProps } from "react";

import { useKeyboardViewport } from "../hooks/use-keyboard-viewport";
import { caretPosition } from "./caret-menu-utils";
import { Button } from "./ui/button";
import {
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "./ui/drawer";

/** Leave an editor line above the sheet, but budget enough space for the header
 * and a complete command row when the keyboard leaves a short visible band. */
export function typingDrawerHeight(height: number) {
  return Math.max(0, Math.min(height - 48, Math.max(168, height * 0.5)));
}

/** Shared drawer frame. Typing menus leave focus in the editor; modal pickers
 * own focus. Both fit the visual viewport rather than hiding under a keyboard. */
export function MenuDrawerContent({
  title,
  typing = false,
  children,
  ...props
}: ComponentProps<typeof DrawerContent> & { title: string; typing?: boolean }) {
  const { height, offsetTop } = useKeyboardViewport();

  useEffect(() => {
    if (!typing) return;
    const frame = requestAnimationFrame(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
      // Quick-add scrolls within its clipped frame. The outline scrolls the
      // window, using temporary bottom breathing room. Neither moves focus.
      const capture = el.closest<HTMLElement>(".quick-add-popup");
      if (capture) {
        const rect = capture.getBoundingClientRect();
        const y = caretPosition(el).y;
        const top = rect.top + parseFloat(getComputedStyle(el).lineHeight) + 4;
        const bottom = rect.bottom - 4;
        if (y > bottom) capture.scrollTop += y - bottom;
        else if (y < top) capture.scrollTop += y - top;
        return;
      }
      if (el.closest('[role="dialog"]')) return;
      const bottom = offsetTop + height - typingDrawerHeight(height) - 8;
      const delta = caretPosition(el).y - bottom;
      if (delta > 0) window.scrollBy({ top: delta, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
    // Recheck when filtering changes the contents or wraps the edited line.
  }, [typing, height, offsetTop, children]);

  return (
    <DrawerContent
      initialFocus={typing ? false : undefined}
      finalFocus={typing ? false : undefined}
      viewportStyle={{ top: offsetTop, height, bottom: "auto" }}
      style={{
        maxHeight: typing
          ? typingDrawerHeight(height)
          : Math.max(0, height - 32),
      }}
      onPointerDown={
        typing
          ? (e) => {
              // Let Base UI start handle swipes before cancelling native mouse focus.
              if (
                !(e.target instanceof Element) ||
                !e.target.closest('[data-slot="drawer-swipe-handle"]')
              )
                e.preventDefault();
            }
          : undefined
      }
      onMouseDown={typing ? (e) => e.preventDefault() : undefined}
      {...props}
    >
      <DrawerHeader
        className={
          typing
            ? "flex-row items-center justify-between gap-2 px-3 py-1"
            : "flex-row items-center justify-between gap-2 pb-2"
        }
      >
        <DrawerTitle>{title}</DrawerTitle>
        <DrawerClose
          render={<Button variant="ghost" size="sm" className="min-h-11" />}
        >
          Close
        </DrawerClose>
      </DrawerHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </DrawerContent>
  );
}
