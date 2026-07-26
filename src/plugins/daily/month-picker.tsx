// Compact Mon-start month calendar popover for the week strip (ADR 0055).
// Purpose-built — no react-day-picker. Day pick → seed-free goToDate.

import { Effect } from "effect";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/plugins/kit";

import type { PluginContext } from "../types";

import {
  formatDateFull,
  localDateKey,
  monthKeyToCalendarGrid,
  monthKeyToYearKey,
  monthLabel,
  shiftMonthKey,
} from "../../data/date-links";
import { useDaysWithContent } from "./days-with-content";
import { goToDate } from "./get-or-create";

const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

export function MonthPickerButton({
  monthKey,
  selectedDayKey,
  getCtx,
  onPicked,
}: {
  monthKey: string;
  selectedDayKey: string;
  getCtx: () => PluginContext;
  /** Called after a day is chosen (caller resets week-strip offset). */
  onPicked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(monthKey);

  const monthYear = `${monthLabel(monthKey)} ${monthKeyToYearKey(monthKey) ?? ""}`;

  const cells = useMemo(
    () => monthKeyToCalendarGrid(viewMonth) ?? [],
    [viewMonth],
  );
  const cellKeys = useMemo(() => cells.map((c) => c.key), [cells]);
  const withContent = useDaysWithContent(cellKeys);
  const today = localDateKey();
  const viewLabel = `${monthLabel(viewMonth)} ${monthKeyToYearKey(viewMonth) ?? ""}`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setViewMonth(monthKey);
      }}
    >
      <PopoverTrigger
        type="button"
        data-testid="week-calendar-month"
        aria-label={`Open calendar for ${monthYear}`}
        className="truncate rounded-md px-1 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        {monthYear}
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={6}
        className="w-[min(18rem,calc(100vw-2rem))] p-2"
        data-testid="week-calendar-month-picker"
      >
        <div className="mb-2 flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            data-testid="month-picker-prev"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => {
              const next = shiftMonthKey(viewMonth, -1);
              if (next) setViewMonth(next);
            }}
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1 truncate text-center text-xs font-medium">
            {viewLabel}
          </div>
          <button
            type="button"
            aria-label="Next month"
            data-testid="month-picker-next"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => {
              const next = shiftMonthKey(viewMonth, 1);
              if (next) setViewMonth(next);
            }}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="mb-1 grid grid-cols-7 gap-0.5">
          {WEEKDAY_INITIALS.map((w, i) => (
            <div
              key={`${w}-${i}`}
              className="text-center text-[0.6rem] text-muted-foreground"
            >
              {w}
            </div>
          ))}
        </div>
        <ul className="grid grid-cols-7 gap-0.5">
          {cells.map(({ key, inMonth }) => {
            const selected = key === selectedDayKey;
            const isToday = key === today;
            const hasContent = withContent.has(key);
            const dayOfMonth = Number(key.slice(8, 10));
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-label={formatDateFull(key)}
                  aria-pressed={selected}
                  data-day-key={key}
                  data-in-month={inMonth ? "" : undefined}
                  data-selected={selected ? "" : undefined}
                  data-today={isToday ? "" : undefined}
                  disabled={!inMonth}
                  onClick={() => {
                    if (!inMonth) return;
                    if (key !== selectedDayKey) {
                      const ctx = getCtx();
                      ctx.run(
                        Effect.promise(() =>
                          goToDate(key, ctx, { morph: false }),
                        ),
                      );
                    }
                    setOpen(false);
                    onPicked();
                  }}
                  className={cn(
                    "relative flex w-full flex-col items-center gap-0.5 rounded-md px-0.5 py-1 text-xs transition-colors",
                    !inMonth && "invisible",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : isToday
                        ? "font-medium text-foreground hover:bg-muted"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <span className="leading-none tabular-nums">
                    {dayOfMonth}
                  </span>
                  <span
                    aria-hidden="true"
                    data-has-content={hasContent ? "" : undefined}
                    className={cn(
                      "size-1 rounded-full bg-current transition-opacity",
                      hasContent ? "opacity-70" : "opacity-0",
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
