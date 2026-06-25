import { cn } from "../lib/utils";
import type { CommandSpec } from "../plugins/types";

export function SlashMenuList({
  items,
  activeIndex,
  x,
  y,
  onHover,
  onSelect,
}: {
  items: CommandSpec[];
  activeIndex: number;
  x: number;
  y: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      className="bg-popover text-popover-foreground fixed z-50 max-h-72 w-64 overflow-y-auto rounded-md border p-1 shadow-md"
      style={{ left: x, top: y + 6 }}
    >
      {items.length === 0 ? (
        <div className="text-muted-foreground px-2 py-1.5 text-sm">
          No commands
        </div>
      ) : (
        items.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
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
              <Icon className="size-4 shrink-0 opacity-70" />
              <span className="flex flex-col">
                <span className="font-medium">{item.label}</span>
                <span className="text-muted-foreground text-xs">
                  {item.description}
                </span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
