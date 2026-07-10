import { cn } from "@/lib/utils";
import { badgeVariants } from "@/plugins/kit";

/** Inline `#tag` chip in bullet text (Seam A — injected as HTML, not `<Badge>`). */
export const TAG_CHIP_CLASS = cn(
  badgeVariants({ variant: "outline" }),
  "tag cursor-pointer text-[0.85em] hover:bg-muted hover:text-muted-foreground",
);
