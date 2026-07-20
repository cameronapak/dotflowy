// Week calendar strip (ADR 0054): a subheader band shown ONLY when zoomed on a
// daily day note, for one-click day-to-day navigation.
//
// Adapted from iconiqui's week-calendar
// (https://iconiqui.com/display-and-content/week-calendar), MIT licensed. This is
// a purpose-built rewrite, not a vendored copy: only the seven-pill week row, the
// tween-animated selection pill, and chevron paging are kept -- the grabber
// handle, the week->month morph/grid, drag/swipe gestures, and the blur dissolve
// are deliberately cut (ADR 0054, decision 4). The chrome stays STATIONARY across
// day switches: the pill (the sole mover) tweens with the house curve, the week
// row has no entrance animation, and paging swaps instantly. Styled with dotflowy
// theme tokens
// (bg-muted / text-muted-foreground / primary / border), never the upstream
// palette. ISO (Monday-start) week truth stays in date-links.ts -- this file adds
// no parallel week math.

import { useParams } from "@tanstack/react-router";
import { Effect } from "effect";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
} from "../../data/date-links";
import { getTreeIndex, subscribeTree } from "../../data/tree-store";
import {
  getMappedId,
  subscribeDailyIndex,
  useScaffoldKey,
} from "./daily-index";
import { goToDate } from "./get-or-create";

// Weekday initials, Monday-first (matches weekKeyToDays' Mon..Sun order).
const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

const EMPTY_KEYSET: ReadonlySet<string> = new Set();

/** The content-dot sources: the tree store (a day node's children) AND the daily
 *  index (its `key -> nodeId` mapping). Both must be reactive so a dot lights the
 *  moment content lands or a day is minted. Module-level, so it's a stable
 *  `useSyncExternalStore` subscribe. */
function subscribeContentSources(cb: () => void): () => void {
  const untree = subscribeTree(cb);
  const undaily = subscribeDailyIndex(cb);
  return () => {
    untree();
    undaily();
  };
}

/**
 * The subset of `dayKeys` that have a dot: the day key maps to a node AND that
 * node has at least one child ("you wrote something here" -- ADR 0054, decision
 * 6; existence alone would light every seed-free peek). Caches on a stable string
 * signature so the returned Set keeps its identity until the dotted set actually
 * changes, as `useSyncExternalStore` requires. `dayKeys` must be referentially
 * stable across renders (the caller memoizes it on the visible week).
 */
function useDaysWithContent(dayKeys: string[]): ReadonlySet<string> {
  const cacheRef = useRef<{ sig: string; set: Set<string> } | null>(null);
  const getSnapshot = useCallback(() => {
    const index = getTreeIndex();
    const present: string[] = [];
    for (const key of dayKeys) {
      const id = getMappedId(key);
      if (id && (index.childrenByParent.get(id)?.length ?? 0) > 0)
        present.push(key);
    }
    const sig = present.join(",");
    if (!cacheRef.current || cacheRef.current.sig !== sig)
      cacheRef.current = { sig, set: new Set(present) };
    return cacheRef.current.set;
  }, [dayKeys]);
  return useSyncExternalStore(
    subscribeContentSources,
    getSnapshot,
    () => EMPTY_KEYSET,
  );
}

/** The ISO week-number badge for a week key: `2026-W29` -> `W29` (no leading
 *  zero). Display-only string formatting; the week itself is ISO truth from
 *  date-links. Empty on a malformed key (never reached -- the caller guards). */
function weekNumberBadge(weekKey: string): string {
  const m = /-W(\d{2})$/.exec(weekKey);
  return m ? `W${Number(m[1])}` : "";
}

export function WeekCalendar({ getCtx }: { getCtx: () => PluginContext }) {
  const params = useParams({ strict: false }) as { nodeId?: string };
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
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
  }, [dayKey]);

  const baseWeek = dayKey ? dayKeyToWeekKey(dayKey) : null;
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
  const weekNum = weekNumberBadge(visibleWeek);
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
          ISO week-number badge; a snap-back affordance appears while paged. */}
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
          <span
            data-testid="week-calendar-month"
            className="truncate text-xs font-medium text-foreground"
          >
            {monthYear}
          </span>
          <span
            data-testid="week-calendar-weeknum"
            className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] leading-none text-muted-foreground"
          >
            {weekNum}
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
          paging swaps the row instantly -- the month label and W-number badge
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
                  "relative flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-xs transition-colors",
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
                      className="absolute inset-0 rounded-md bg-primary"
                    />
                  ) : (
                    <motion.span
                      aria-hidden="true"
                      layoutId="week-calendar-selected"
                      className="absolute inset-0 rounded-md bg-primary"
                      transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                    />
                  )
                ) : null}
                <span className="relative text-[0.6rem] leading-none opacity-70">
                  {WEEKDAY_INITIALS[i]}
                </span>
                <span className="relative leading-none tabular-nums">
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
