import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A physical keycap. Dotflowy is keyboard-first, so shortcuts are shown as
 * real keys throughout the page rather than described in prose. */
export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border bg-card px-1.5 font-mono text-[11px] leading-none font-medium text-muted-foreground shadow-[0_1px_0_0_var(--border)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
