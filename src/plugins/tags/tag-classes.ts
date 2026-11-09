import { cn } from "@/lib/utils";
import { badgeVariants } from "@/plugins/kit";

/** Inline `#tag` chip in bullet text (Seam A — injected as HTML, not `<Badge>`). */
export const TAG_CHIP_CLASS = cn(
  badgeVariants({ variant: "outline" }),
  // Grow with the editor font, including zoomed titles, rather than clipping
  // larger text inside the kit badge's fixed 20px height. Scale the vertical
  // padding too so larger reading sizes keep room above and below the glyphs.
  "tag h-auto cursor-pointer py-[0.2em] text-[0.85em] leading-none hover:bg-muted hover:text-muted-foreground",
);
