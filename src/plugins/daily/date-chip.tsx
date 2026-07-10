// The date-link chip, as REAL TSX (ADR 0006 -- Seam A's React mode), mounted
// inside a `<dotflowy-widget>` atom (ADR 0038). It speaks the daily BADGE
// language -- Today with a sun icon / Yesterday / Tomorrow / "Jul 8" -- so a
// `[[2026-07-08]]` chip and that day note's own badge can't disagree; the
// absolute date lives in the hover `title`, and an optional `HH:MM` time
// trails the label (display + round-trip only, never identity).
//
// Purely presentational, computed from the token's key alone: it must NOT
// touch the daily index (no lookup, no get-or-create) -- 2,683 imported chips
// mint zero day notes until clicked (ADR 0038). Click-to-travel is Seam B
// (delegated on `data-date-link` in index.tsx). The atom is
// `contenteditable="false"`: the caret jumps over it, backspace deletes the
// whole token, copy reads back `data-src`.

import { SunIcon } from "lucide-react";

import { Badge } from "@/plugins/kit";

import type { WidgetProps } from "../types";

import {
  formatDateFull,
  formatDateLabel,
  localDateKey,
  parseDateLink,
} from "../../data/date-links";

export function DateLinkChip({ source }: WidgetProps) {
  // The token render gates on parseDateLink, so this can't miss -- but a chip
  // must never crash the row, so a (theoretical) miss degrades to the source.
  const parsed = parseDateLink(source);
  if (!parsed) return <span>{source}</span>;
  const { key, time } = parsed;
  const isToday = key === localDateKey();
  return (
    <Badge
      variant={isToday ? "default" : "secondary"}
      className={
        "cursor-pointer border! align-baseline whitespace-nowrap transition-transform select-none hover:brightness-[0.97] active:translate-y-px dark:hover:brightness-110 " +
        (isToday ? "border-transparent" : "border-border")
      }
      title={formatDateFull(key)}
      data-daily-today={isToday ? "" : undefined}
    >
      {isToday && <SunIcon className="shrink-0" aria-hidden="true" />}
      {time ? `${formatDateLabel(key)} ${time}` : formatDateLabel(key)}
    </Badge>
  );
}
