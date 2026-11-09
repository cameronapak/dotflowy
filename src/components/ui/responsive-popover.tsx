import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
  type CSSProperties,
} from "react";
import { DialogTrigger } from "react-aria-components/Dialog";

import { useIsMobile } from "@/hooks/use-mobile";

import { MenuSheetButton, MenuSheetContent } from "../menu-sheet";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const MobileTitle = createContext<string | null>(null);

export function ResponsivePopover({
  title,
  open,
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
      {mobile ? (
        <DialogTrigger isOpen={open} {...props} />
      ) : (
        <Popover open={open} {...props} />
      )}
    </MobileTitle>
  );
}

export function ResponsivePopoverTrigger(props: ComponentProps<"button">) {
  return useContext(MobileTitle) ? (
    <MenuSheetButton {...props} />
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
  onAfterClose,
  ...props
}: Omit<
  ComponentProps<typeof PopoverContent>,
  "render" | "className" | "style"
> & { className?: string; style?: CSSProperties; onAfterClose?: () => void }) {
  const title = useContext(MobileTitle);
  return title ? (
    <MenuSheetContent title={title} onAfterClose={onAfterClose}>
      {props.children}
    </MenuSheetContent>
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
