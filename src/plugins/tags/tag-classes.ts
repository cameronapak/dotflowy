import { cn } from "@/lib/utils";
import { badgeVariants } from "@/plugins/kit";

/** Inline `#tag` chip in bullet text (Seam A — injected as HTML, not `<Badge>`). */
export const TAG_CHIP_CLASS = cn(
  badgeVariants({ variant: "outline" }),
  // Grow with the editor font, including zoomed titles, rather than clipping
  // larger text inside the kit badge's fixed 20px height. Scale the vertical
  // padding too so larger reading sizes keep room above and below the glyphs.
  "tag h-auto cursor-pointer border-current/15 bg-current/5 py-[0.2em] align-middle text-[0.85em] leading-none text-(--inline-ink) [text-decoration-line:var(--inline-strike,)_var(--inline-underline,)] transition-[background-color,border-color] hover:bg-current/10 [.md-bold_&]:font-bold",
);
