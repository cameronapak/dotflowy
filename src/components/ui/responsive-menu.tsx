import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import { DialogTrigger } from "react-aria-components/Dialog";

import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

import { MenuSheetButton, MenuSheetContent } from "../menu-sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
} from "./dropdown-menu";
import { Separator } from "./separator";

const MobileMenu = createContext<{
  title: string;
  close: (action?: () => void) => void;
  afterClose: () => void;
} | null>(null);

export function ResponsiveMenu({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | undefined>(undefined);
  return (
    <MobileMenu
      value={
        mobile
          ? {
              title,
              close: (action) => {
                pending.current = action;
                setOpen(false);
              },
              afterClose: () => {
                const action = pending.current;
                pending.current = undefined;
                action?.();
              },
            }
          : null
      }
    >
      {mobile ? (
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
          {children}
        </DialogTrigger>
      ) : (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          {children}
        </DropdownMenu>
      )}
    </MobileMenu>
  );
}

export function ResponsiveMenuTrigger(
  props: ComponentProps<"button"> & {
    render?: ReactElement<ComponentProps<"button">>;
  },
) {
  return useContext(MobileMenu) ? (
    <MenuSheetButton {...props} />
  ) : (
    <DropdownMenuTrigger {...props} />
  );
}

export function ResponsiveMenuContent({
  children,
  align,
  className,
}: ComponentProps<typeof DropdownMenuContent>) {
  const mobile = useContext(MobileMenu);
  return mobile ? (
    <MenuSheetContent title={mobile.title} onAfterClose={mobile.afterClose}>
      <div
        role="menu"
        aria-label={mobile.title}
        onKeyDown={(e) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const items = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button[role^="menuitem"]:not(:disabled)',
            ),
          ];
          const current = items.findIndex(
            (item) => item === document.activeElement,
          );
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? items.length - 1
                : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                  items.length;
          items[next]?.focus();
        }}
      >
        {children}
      </div>
    </MenuSheetContent>
  ) : (
    <DropdownMenuContent align={align} className={className}>
      <DropdownMenuGroup>{children}</DropdownMenuGroup>
    </DropdownMenuContent>
  );
}

const itemClass =
  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

export function ResponsiveMenuItem({
  children,
  onClick,
  onAfterClose,
  className,
  variant,
  ...props
}: Pick<
  ComponentProps<typeof DropdownMenuItem>,
  "children" | "className" | "variant" | "disabled"
> & {
  "data-unseen"?: string;
  onClick?: () => void;
  /** Focus handoffs wait for the native top layer; wide menus run immediately. */
  onAfterClose?: () => void;
}) {
  const mobile = useContext(MobileMenu);
  return mobile ? (
    <button
      {...props}
      type="button"
      role="menuitem"
      className={cn(
        itemClass,
        variant === "destructive" && "text-destructive",
        className,
      )}
      onClick={() => {
        mobile.close(onAfterClose);
        // Clipboard writes and new tabs must retain the original user gesture.
        onClick?.();
      }}
    >
      {children}
    </button>
  ) : (
    <DropdownMenuItem
      onClick={() => {
        onClick?.();
        onAfterClose?.();
      }}
      className={className}
      variant={variant}
      {...props}
    >
      {children}
    </DropdownMenuItem>
  );
}

export function ResponsiveMenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
}: Omit<ComponentProps<typeof DropdownMenuCheckboxItem>, "onCheckedChange"> & {
  onCheckedChange?: (checked: boolean) => void;
}) {
  return useContext(MobileMenu) ? (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className={itemClass}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {children}
      <span aria-hidden="true" className="ml-auto">
        {checked ? "✓" : ""}
      </span>
    </button>
  ) : (
    <DropdownMenuCheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
    >
      {children}
    </DropdownMenuCheckboxItem>
  );
}

export function ResponsiveMenuSeparator() {
  return useContext(MobileMenu) ? (
    <Separator className="my-2" />
  ) : (
    <DropdownMenuSeparator />
  );
}
