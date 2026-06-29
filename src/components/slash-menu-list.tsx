import type { ComponentType, CSSProperties, Ref } from "react";
import { cn } from "@/lib/utils";

/** The minimal item shape this list renders: an id, the two text lines, and a
 *  leading icon. `CommandSpec` satisfies it, and so do the synthetic core items
 *  the node-selection actions menu builds (ADR 0018) -- both reuse this one menu
 *  look. The parent owns what a pick DOES (via `onSelect(index)`), so the item
 *  needs no `run`. */
export interface MenuListItem {
  id: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Presentational only: renders the listbox + its options. **Positioning is the
 * caller's job** -- it passes the `style` (and `ref`, for libraries that attach
 * to the floating element). The slash menu fixes itself at the caret; the
 * selection actions menu (ADR 0018) hands this to floating-ui for collision-aware
 * placement. Keeping geometry out of here means neither caller reinvents it.
 */
export function SlashMenuList({
  items,
  activeIndex,
  onHover,
  onSelect,
  style,
  ref,
}: {
  items: MenuListItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  /** Position the listbox. Caller owns it (fixed coords, or floating-ui styles). */
  style?: CSSProperties;
  /** Attach the floating element (e.g. floating-ui's `refs.setFloating`). */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      role="listbox"
      className="bg-popover text-popover-foreground fixed z-50 max-h-72 w-64 overflow-y-auto rounded-md border p-1 shadow-md"
      style={style}
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
