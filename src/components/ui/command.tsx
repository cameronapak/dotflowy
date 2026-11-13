"use client";

import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon, CheckIcon } from "lucide-react";
import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { useKeyboardViewport } from "@/hooks/use-keyboard-viewport";
import { cn } from "@/lib/utils";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full min-h-0 flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  finalFocus,
  animateResize = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"];
  /** Smooth Find's changing result count, without delaying open or selection. */
  animateResize?: boolean;
  children: React.ReactNode;
}) {
  const { height, offsetTop } = useKeyboardViewport();
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Keep the ref stable across queries so observation retains the previous size.
  const resizeRef = React.useCallback(
    (popup: HTMLDivElement | null) => {
      const surface = surfaceRef.current;
      const content = contentRef.current;
      if (!popup || !surface || !content || !animateResize) return;
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      );
      let previousHeight = popup.offsetHeight;
      let position: Animation | undefined;
      let surfaceAnimation: Animation | undefined;
      let revealAnimation: Animation | undefined;
      const cancelResize = () => {
        position?.cancel();
        surfaceAnimation?.cancel();
        revealAnimation?.cancel();
      };
      reducedMotion.addEventListener("change", cancelResize);
      const observer = new ResizeObserver(() => {
        const nextHeight = popup.offsetHeight;
        if (nextHeight === previousHeight || nextHeight === 0) return;
        // Retarget from the currently drawn position and size if typing interrupts
        // a resize. Only the backplate scales; glyphs keep their natural size.
        const offset = new DOMMatrixReadOnly(getComputedStyle(popup).transform)
          .m42;
        const scale = new DOMMatrixReadOnly(getComputedStyle(surface).transform)
          .m22;
        cancelResize();
        if (reducedMotion.matches) {
          previousHeight = nextHeight;
          return;
        }
        const timing = {
          duration: 160,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        };
        position = popup.animate(
          [
            {
              transform: `translateY(${(nextHeight - previousHeight) / 2 + offset}px)`,
            },
            { transform: "translateY(0px)" },
          ],
          timing,
        );
        surfaceAnimation = surface.animate(
          [
            { transform: `scaleY(${(previousHeight * scale) / nextHeight})` },
            { transform: "scaleY(1)" },
          ],
          timing,
        );
        // Reveal expanding rows only as their background reaches them. Clip the
        // content separately so a shrinking backplate can retain its old height.
        revealAnimation = content.animate(
          [
            {
              clipPath: `inset(0 0 ${Math.max(0, nextHeight - previousHeight * scale)}px 0)`,
            },
            { clipPath: "inset(0 0 0px 0)" },
          ],
          timing,
        );
        previousHeight = nextHeight;
      });
      observer.observe(popup);
      return () => {
        observer.disconnect();
        reducedMotion.removeEventListener("change", cancelResize);
        cancelResize();
      };
    },
    [animateResize],
  );

  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        ref={resizeRef}
        className={cn(
          "flex flex-col overflow-hidden rounded-xl! p-0",
          animateResize && "isolate overflow-visible bg-transparent ring-0",
          className,
        )}
        style={{
          top: height ? offsetTop + height / 2 : undefined,
          maxHeight: height ? Math.max(0, height - 32) : undefined,
        }}
        showCloseButton={showCloseButton}
        animate={false}
        finalFocus={finalFocus}
      >
        {animateResize ? (
          <>
            <div
              ref={surfaceRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 origin-top rounded-xl bg-popover ring-1 ring-foreground/10"
            />
            <div
              ref={contentRef}
              className="relative flex min-h-0 flex-col overflow-hidden rounded-xl [&_[data-slot=command]]:bg-transparent"
            >
              {children}
            </div>
          </>
        ) : (
          children
        )}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 min-h-0 scroll-fade scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-selected:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
