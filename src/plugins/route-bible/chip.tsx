// The route-bible chip, as REAL TSX (ADR 0006 -- Seam A's React mode). It mounts
// inside the `<dotflowy-widget>` atom, so all of its look is plain Tailwind
// utility classes + lucide icons -- NO plugin CSS string (the old styles.ts is
// gone), and the icons are components, not SVG-mask pseudo-elements. The atom is
// `contenteditable="false"`, so this interior never takes the caret; the source
// label still reads back via the atom's `data-src` (the caret math never
// descends in here). Click-to-open stays Seam B (delegated on `data-bible-ref`),
// so this component is purely presentational -- it only needs `source`.

import { BookOpen, ExternalLink } from "lucide-react";
import type { WidgetProps } from "../types";

export function BibleChip({ source }: WidgetProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-1.5 py-0.5 align-baseline text-[0.85em] font-medium text-secondary-foreground whitespace-nowrap cursor-pointer select-none transition-transform active:translate-y-px hover:brightness-[0.97] dark:hover:brightness-110">
      <BookOpen className="size-[1em] shrink-0" aria-hidden="true" />
      {source}
      <ExternalLink
        className="size-[0.7em] shrink-0 opacity-70"
        aria-hidden="true"
      />
    </span>
  );
}
