import * as React from "react";

import { cn } from "@/lib/utils";

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground [&_svg:not([class*='size-'])]:size-3",
        "[[data-slot=kbd-group]_&]:h-4 [[data-slot=kbd-group]_&]:min-w-4",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
