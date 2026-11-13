import type { ComponentType, CSSProperties, Ref } from "react";

import { MenuList } from "./menu-list";

export interface MenuListItem {
  id: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export function SlashMenuList({
  items,
  inDock = false,
  ...props
}: {
  items: MenuListItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  inDock?: boolean;
}) {
  return (
    <MenuList
      {...props}
      inDock={inDock}
      label="Commands"
      emptyLabel="No commands"
      className={!inDock ? "fixed" : undefined}
      entries={items.map((item) => ({
        key: item.id,
        render: (active) => {
          const Icon = item.icon;
          return (
            <>
              <Icon className="size-4 shrink-0 opacity-70" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{item.label}</span>
                {!inDock && (
                  // On the selected row the hint fades from the row's own
                  // ink, so it reads on any theme's highlight (ADR 0082).
                  <span
                    className={
                      active
                        ? "text-xs text-accent-foreground/85"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {item.description}
                  </span>
                )}
              </span>
            </>
          );
        },
      }))}
    />
  );
}
