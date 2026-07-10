import { cn } from "@/lib/utils";

import type { MenuEntry } from "../plugins/types";

export function MenuList({
  entries,
  activeIndex,
  emptyLabel,
  x,
  y,
  onHover,
  onSelect,
}: {
  entries: MenuEntry[];
  activeIndex: number;
  emptyLabel?: string;
  x: number;
  y: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      className="fixed z-50 max-h-72 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: x, top: y + 6 }}
    >
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
  );
}
