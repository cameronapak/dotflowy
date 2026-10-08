// Week calendar strip (ADR 0054): a subheader band shown ONLY when zoomed on a
// daily day note, for one-click day-to-day navigation.
//
// Adapted from iconiqui's week-calendar
// (https://iconiqui.com/display-and-content/week-calendar), MIT licensed. This is
// a purpose-built rewrite, not a vendored copy: only the seven-pill week row, the
// tween-animated selection pill, and chevron paging are kept -- the grabber
// handle, the week->month morph/grid, drag/swipe gestures, and the blur dissolve
// are deliberately cut (ADR 0054, decision 4). ADR 0055 adds a compact month
// picker on the month label (popover), not an in-strip month morph. The chrome
// stays STATIONARY across day switches: the pill (the sole mover) tweens with
// the house curve, the week row has no entrance animation, and paging swaps
// instantly. Styled with dotflowy theme tokens
// (bg-muted / text-muted-foreground / primary / border), never the upstream
// palette. Account Calendar-week truth stays in date-links.ts -- this file adds
// no parallel week math.

import { useParams } from "@tanstack/react-router";
import { Effect } from "effect";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import type { PluginContext } from "../types";

import {
  dayKeyToWeekKey,
  formatDateFull,
  localDateKey,
  monthKeyToYearKey,
  monthLabel,
  scaffoldKeyKind,
  shiftWeekKey,
  weekKeyToDays,
  weekKeyToMonthKey,
  weekLabel,
} from "../../data/date-links";
import { useEditorFeatures } from "../../data/editor-features";
import { useScaffoldKey } from "./daily-index";
import { useDaysWithContent } from "./days-with-content";
import { goToDate } from "./get-or-create";
import { MonthPickerButton } from "./month-picker";

const WEEKDAY_INITIALS = {
  monday: ["M", "T", "W", "T", "F", "S", "S"],
  sunday: ["S", "M", "T", "W", "T", "F", "S"],
} as const;

export function WeekCalendar({ getCtx }: { getCtx: () => PluginContext }) {
  const { weekStart } = useEditorFeatures();
  const params = useParams({ strict: false });
  const rootId = params.nodeId ?? null;
  // Reactive: the zoom root's scaffold key (null unless it maps to a scaffold
  // node). The strip only shows for a DAY -- week/month/year/container pages and
  // non-daily pages get nothing ("which day is selected?" has no answer there).
  const scaffoldKey = useScaffoldKey(rootId ?? "");
  const dayKey =
    scaffoldKey && scaffoldKeyKind(scaffoldKey) === "day" ? scaffoldKey : null;

  const reduceMotion = useReducedMotion();
  // Ephemeral paging offset from the zoomed day's week (ADR 0054, decision 5):
  // reset whenever the zoomed day changes so the strip re-centers on route change.
  // Layout effect: the strip stays mounted across day switches, so the reset must
  // land before paint or a paged offset flashes the wrong week on day switch.
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    setOffset(0);
  }, [dayKey]);

  const baseWeek = dayKey ? dayKeyToWeekKey(dayKey, weekStart) : null;
  const visibleWeek = useMemo(() => {
    if (!baseWeek) return null;
    if (offset === 0) return baseWeek;
    return shiftWeekKey(baseWeek, offset) ?? baseWeek;
  }, [baseWeek, offset]);

  const days = useMemo(
    () => (visibleWeek ? (weekKeyToDays(visibleWeek) ?? []) : []),
    [visibleWeek],
  );
  const withContent = useDaysWithContent(days);

  // Guard AFTER every hook (rules of hooks): render nothing on a non-day page, so
  // the subheader band collapses.
  if (!dayKey || !visibleWeek || days.length !== 7) return null;

  const today = localDateKey();
  const monthKey = weekKeyToMonthKey(visibleWeek);
  const monthYear = monthKey
    ? `${monthLabel(monthKey)} ${monthKeyToYearKey(monthKey)}`
    : "";
  const weekRange = weekLabel(visibleWeek);
  const paged = offset !== 0;

  const iconBtn =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    <nav
      aria-label="Week calendar"
      data-testid="week-calendar"
      data-week-key={visibleWeek}
      className="flex w-full flex-col gap-1"
    >
      {/* Orientation row: paging chevrons flank a quiet month+year label and the
          week range; a snap-back affordance appears while paged. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous week"
          className={iconBtn}
          onClick={() => setOffset((o) => o - 1)}
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          {monthKey ? (
            <MonthPickerButton
              monthKey={monthKey}
              selectedDayKey={dayKey}
              weekStart={weekStart}
              getCtx={getCtx}
              onPicked={() => setOffset(0)}
            />
          ) : (
            <span
              data-testid="week-calendar-month"
              className="truncate text-xs font-medium text-foreground"
            >
              {monthYear}
            </span>
          )}
          <span
            data-testid="week-calendar-week-range"
            className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] leading-none text-muted-foreground"
          >
            {weekRange}
          </span>
          {paged ? (
            <button
              type="button"
              aria-label="Back to the current week"
              data-testid="week-calendar-snapback"
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setOffset(0)}
            >
              <RotateCcw className="size-3" />
              This week
            </button>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Next week"
          className={iconBtn}
          onClick={() => setOffset((o) => o + 1)}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      {/* The seven day pills. No entrance animation (ADR 0054, decision 4):
          paging swaps the row instantly -- the month label and week range
          carry the week change -- and a same-week day switch is silent chrome.
          The ONLY thing that moves is the layoutId selection pill, which tweens
          from the old day to the new one. */}
      <ul className="grid grid-cols-7 gap-1">
        {days.map((key, i) => {
          const selected = key === dayKey;
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
                data-selected={selected ? "" : undefined}
                data-today={isToday ? "" : undefined}
                onClick={() => {
                  // Clicking the already-selected day is a no-op (ADR 0054).
                  if (key === dayKey) return;
                  const ctx = getCtx();
                  // Seed-free get-or-create (the date-chip semantics, ADR
                  // 0038/0041: no seeded entry line, no ?focus=last), but a
                  // PLAIN navigation (`morph: false`) -- the layoutId pill IS
                  // the transition, so a zoom morph would stack a redundant
                  // title pop-in over it (ADR 0054).
                  ctx.run(
                    Effect.promise(() => goToDate(key, ctx, { morph: false })),
                  );
                }}
                className={cn(
                  "group relative flex w-full scale-100 flex-col items-center gap-0.5 rounded-md border-2 border-transparent px-1 py-1.5 text-xs transition-[color,background-color,border-color,transform] after:pointer-events-none after:absolute after:-inset-1 after:rounded-md after:border-[3px] after:border-transparent after:content-[''] data-[external-drop-active]:scale-[1.03] data-[external-drop-active]:border-primary data-[external-drop-active]:bg-muted! data-[external-drop-active]:text-foreground! data-[external-drop-active]:after:border-primary/20",
                  selected
                    ? "text-primary-foreground"
                    : isToday
                      ? "font-medium text-foreground hover:bg-muted"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {/* The selection highlight (motion layoutId): it slides from the
                    old day to the new one on a day switch, and snaps under
                    reduced motion. A tween on the house curve (the same
                    cubic-bezier the zoom morph uses in styles.css), not a spring
                    -- dotflowy doesn't use springs, and the underdamped spring
                    overshot. This pill is the sole moving element in the strip. */}
                {selected ? (
                  reduceMotion ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 rounded-md bg-primary group-data-[external-drop-active]:hidden"
                    />
                  ) : (
                    <motion.span
                      aria-hidden="true"
                      layoutId="week-calendar-selected"
                      className="absolute inset-0 rounded-md bg-primary group-data-[external-drop-active]:hidden"
                      transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                    />
                  )
                ) : null}
                <span className="relative text-[0.6rem] leading-none opacity-70 group-data-[external-drop-active]:text-foreground!">
                  {WEEKDAY_INITIALS[weekStart][i]}
                </span>
                <span className="relative leading-none tabular-nums group-data-[external-drop-active]:text-foreground!">
                  {dayOfMonth}
                </span>
                {/* Content dot: this day has a mapped node with children. Sits
                    below the number; `bg-current` so it reads on any pill state. */}
                <span
                  aria-hidden="true"
                  data-has-content={hasContent ? "" : undefined}
                  className={cn(
                    "relative size-1 rounded-full bg-current transition-opacity",
                    hasContent ? "opacity-70" : "opacity-0",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
