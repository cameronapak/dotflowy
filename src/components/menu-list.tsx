import type { CSSProperties, Ref } from "react";

import { cn } from "@/lib/utils";

import type { MenuEntry } from "../plugins/types";

export function MenuList({
  entries,
  activeIndex,
  emptyLabel,
  onHover,
  onSelect,
  style,
  ref,
}: {
  entries: MenuEntry[];
  activeIndex: number;
  emptyLabel?: string;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  /** Position the listbox. The caller owns it (clamped-to-viewport fixed coords
   *  via `useClampedMenuPosition`). */
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      role="listbox"
      className="z-50 w-64 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
      style={style}
    >
      {/* Scroll + fade live on an inner div with NO background, so the mask
          dissolves content into the card's bg-popover (matching the Cmd+K
          list), not into the darker editor background behind the card. */}
      <div className="max-h-72 scroll-fade overflow-y-auto p-1">
        {entries.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {emptyLabel ?? "No results"}
          </div>
        ) : (
          entries.map((entry, i) => (
            <button
              key={entry.key}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                i === activeIndex && "bg-accent text-accent-foreground",
              )}
              // mousedown (not click) so the contentEditable keeps focus.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(i);
              }}
              onMouseEnter={() => onHover(i)}
            >
              {entry.render(i === activeIndex)}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
