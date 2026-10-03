import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
  type CSSProperties,
} from "react";

import { useIsMobile } from "@/hooks/use-mobile";

import { MenuDrawerContent } from "../menu-drawer";
import { Drawer, DrawerTrigger } from "./drawer";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const MobileTitle = createContext<string | null>(null);

export function ResponsivePopover({
  title,
  ...props
}: {
  title: string;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mobile = useIsMobile();
  return (
    <MobileTitle value={mobile ? title : null}>
      {mobile ? <Drawer showSwipeHandle {...props} /> : <Popover {...props} />}
    </MobileTitle>
  );
}

export function ResponsivePopoverTrigger(props: ComponentProps<"button">) {
  return useContext(MobileTitle) ? (
    <DrawerTrigger {...props} />
  ) : (
    <PopoverTrigger {...props} />
  );
}

export function ResponsivePopoverContent({
  align,
  alignOffset,
  side,
  sideOffset,
  className,
  ...props
}: Omit<
  ComponentProps<typeof PopoverContent>,
  "render" | "className" | "style"
> & { className?: string; style?: CSSProperties }) {
  const title = useContext(MobileTitle);
  return title ? (
    <MenuDrawerContent title={title} {...props} />
  ) : (
    <PopoverContent
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={className}
      {...props}
    />
  );
}
