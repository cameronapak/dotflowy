// The route-bible chip, as REAL TSX (ADR 0006 -- Seam A's React mode). It mounts
// inside the `<dotflowy-widget>` atom, so all of its look is plain Tailwind
// utility classes + Hugeicons -- NO plugin CSS string (the old styles.ts is
// gone), and the icons are components, not SVG-mask pseudo-elements. The atom is
// `contenteditable="false"`, so this interior never takes the caret; the source
// label still reads back via the atom's `data-src` (the caret math never
// descends in here). Click-to-open stays Seam B (delegated on `data-bible-ref`),
// so this component is purely presentational -- it only needs `source`.

import { BookOpenIcon, ExternalLinkIcon } from "@/lib/icons";

import type { WidgetProps } from "../types";

export function BibleChip({ source }: WidgetProps) {
  return (
    <span className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-current/15 bg-current/5 px-1.5 py-[0.2em] align-middle text-[0.85em] leading-none font-medium whitespace-nowrap text-(--inline-ink) [text-decoration-line:var(--inline-strike,)_var(--inline-underline,)] transition-[background-color,border-color] select-none hover:bg-current/10 active:translate-y-px [.md-bold_&]:font-bold [.md-highlight_&]:bg-(--highlight-bg) [.md-highlight_&]:hover:border-current/30 [.md-highlight_&]:hover:bg-(--highlight-bg)">
      <BookOpenIcon className="size-[1em] shrink-0" aria-hidden="true" />
      {source}
      <ExternalLinkIcon
        className="size-[0.7em] shrink-0 opacity-70"
        aria-hidden="true"
      />
    </span>
  );
}
