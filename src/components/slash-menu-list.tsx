import type { ComponentType, CSSProperties, Ref } from "react";

import { cn } from "@/lib/utils";

import { useMenuActiveItem } from "./use-menu-active-item";

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
 * to the floating element). The slash menu fixes itself at the caret. Selection
 * actions use Base UI's focused menu instead (ADR 0018); typing suggestions
 * leave focus in the editor.
 */
export function SlashMenuList({
  items,
  activeIndex,
  onHover,
  onSelect,
  style,
  ref,
  inDock = false,
}: {
  items: MenuListItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  /** Position the listbox. Caller owns it (fixed coords, or floating-ui styles). */
  style?: CSSProperties;
  /** Attach the floating element (e.g. floating-ui's `refs.setFloating`). */
  ref?: Ref<HTMLDivElement>;
  inDock?: boolean;
}) {
  const { itemRef, onItemPointerMove } = useMenuActiveItem({
    activeIndex,
    itemCount: items.length,
    onHover,
  });

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Commands"
      className={cn(
        inDock
          ? "w-full"
          : "fixed z-50 w-64 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
      )}
      style={style}
    >
      {/* Scroll + fade live on an inner div with NO background, so the mask
          dissolves content into the card's bg-popover (matching the Cmd+K
          list), not into the darker editor background behind the card. */}
      <div
        className={cn("p-1", !inDock && "max-h-72 scroll-fade overflow-y-auto")}
      >
        {items.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            No commands
          </div>
        ) : (
          items.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                ref={itemRef(i)}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={cn(
                  // scroll-my-10 clears the scroll-fade mask (min(12%, 40px)):
                  // `block: "nearest"` would otherwise park the active item
                  // flush against the edge, where the fade dims the highlight.
                  "flex w-full scroll-my-10 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                  inDock && "h-11 py-2",
                  i === activeIndex && "bg-accent text-accent-foreground",
                )}
                // mousedown (not click) so the contentEditable keeps focus.
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (!inDock) onSelect(i);
                }}
                onClick={inDock ? () => onSelect(i) : undefined}
                onPointerMove={onItemPointerMove(i)}
              >
                <Icon className="size-4 shrink-0 opacity-70" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{item.label}</span>
                  {!inDock && (
                    <span className="text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
