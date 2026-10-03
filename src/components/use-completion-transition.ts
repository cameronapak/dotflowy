import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { VisibleRow } from "../data/visible-order";

const CHECKED_MS = 80;
const EXIT_MS = 160;
const EXIT_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const MOVE_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

type Exit = { start: number; fading: boolean };
type Presentation = { rows: VisibleRow[]; exiting: Map<string, Exit> };
type Motion = {
  animation: Animation;
  target: string;
  deadline: number;
  base: number;
};

/** Save and navigation use canonical rows. Only presentation retains exits.
 * Each render address keeps its own deadline across edits and sync frames;
 * the live render walk excludes collapsed, deleted, and moved-away paths.
 */
export function useCompletionTransition({
  rows,
  eligibleRows,
  query,
  elements,
  listRef,
  measurements,
  onHiddenFocus,
}: {
  rows: VisibleRow[];
  eligibleRows: () => VisibleRow[];
  query: string | undefined;
  elements: Map<string, HTMLSpanElement | null>;
  listRef: RefObject<HTMLElement | null>;
  measurements: RefObject<readonly { start: number; size: number }[]>;
  onHiddenFocus: (
    previous: VisibleRow[],
    next: VisibleRow[],
    exiting: Set<string>,
  ) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [presentation, setPresentation] = useState<Presentation>({
    rows,
    exiting: new Map(),
  });
  const displayed = useRef(presentation);
  const canonical = useRef(rows);
  const previousQuery = useRef(query);
  const motions = useRef(
    new Map<HTMLElement, { opacity?: Motion; transform?: Motion }>(),
  );
  // Rebuild displacement only when rows, phases, or cached sizes change, not
  // on every scroll render. DOM reconciliation below visits mounted rows only.
  const plan = useRef<{
    presentation: Presentation;
    layouts: typeof measurements.current;
    shifts: Map<string, { shift: number; start: number }>;
    shift: number;
    start: number;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = displayed.current;
    const queryChanged = previousQuery.current !== query;
    previousQuery.current = query;
    canonical.current = rows;
    const nextKeys = new Set(rows.map((row) => row.key));
    const missing = previous.rows.filter((row) => !nextKeys.has(row.key));
    const exiting = new Map<string, Exit>();
    let retained = rows;
    if (missing.length && !queryChanged) {
      // Recompute the filter WITHOUT hiding too: canonical filter.visibleIds
      // already excludes completed matches. Reuse the same render-path walker.
      const eligible = eligibleRows();
      const eligibleKeys = new Set(eligible.map((row) => row.key));
      const now = performance.now();
      for (const row of missing) {
        if (eligibleKeys.has(row.key))
          exiting.set(
            row.key,
            previous.exiting.get(row.key) ?? { start: now, fading: false },
          );
      }
      if (
        reduceMotion ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        onHiddenFocus(previous.rows, rows, new Set(exiting.keys()));
        exiting.clear();
      }
      if (exiting.size)
        retained = eligible
          .filter((row) => nextKeys.has(row.key) || exiting.has(row.key))
          .map((row) =>
            exiting.has(row.key) ? { ...row, ancestorCompleted: true } : row,
          );
    }
    // Equivalent filtered snapshots update canonical data without another
    // presentation commit.
    if (
      exiting.size === previous.exiting.size &&
      [...exiting].every(([key, exit]) => previous.exiting.get(key) === exit) &&
      retained.length === previous.rows.length &&
      retained.every((row, i) => {
        const old = previous.rows[i]!;
        return (
          row.key === old.key &&
          row.contentId === old.contentId &&
          row.depth === old.depth &&
          row.ancestorCompleted === old.ancestorCompleted &&
          row.isMirror === old.isMirror &&
          row.capped === old.capped &&
          row.broken === old.broken
        );
      })
    )
      return;
    const next = { rows: retained, exiting };
    displayed.current = next;
    setPresentation(next);
  }, [rows, eligibleRows, query, reduceMotion, onHiddenFocus]);

  // Snapshot updates may reschedule this timeout, but never its deadline.
  // No animation cleanup rides row-array identity or filtered keystrokes.
  useLayoutEffect(() => {
    let deadline = Infinity;
    for (const exit of presentation.exiting.values())
      deadline = Math.min(
        deadline,
        exit.start + CHECKED_MS + (exit.fading ? EXIT_MS : 0),
      );
    if (!Number.isFinite(deadline)) return;
    const timer = window.setTimeout(
      () => {
        const previous = displayed.current;
        const now = performance.now();
        const exiting = new Map<string, Exit>();
        const fading = new Set<string>();
        for (const [key, exit] of previous.exiting) {
          const shouldFade = now >= exit.start + CHECKED_MS;
          if (shouldFade && !exit.fading) fading.add(key);
          if (now >= exit.start + CHECKED_MS + EXIT_MS) continue;
          exiting.set(key, shouldFade ? { ...exit, fading: true } : exit);
        }
        onHiddenFocus(previous.rows, canonical.current, fading);
        const next = {
          rows: exiting.size
            ? previous.rows.filter(
                (row) => !previous.exiting.has(row.key) || exiting.has(row.key),
              )
            : canonical.current,
          exiting,
        };
        displayed.current = next;
        setPresentation(next);
      },
      Math.max(0, deadline - performance.now()),
    );
    return () => window.clearTimeout(timer);
  }, [presentation, onHiddenFocus]);

  useLayoutEffect(
    () => () => {
      for (const properties of motions.current.values())
        for (const motion of Object.values(properties))
          motion.animation.cancel();
      motions.current.clear();
    },
    [],
  );

  // Called after the virtualizer's measurements are published, on every
  // commit. Late mounts join elapsed motion; existing animations stay intact.
  const animateMounted = () => {
    if (presentation !== displayed.current) return;
    if (!presentation.exiting.size && !motions.current.size) {
      plan.current = null;
      return;
    }
    const layouts = measurements.current;
    if (
      plan.current?.presentation !== presentation ||
      plan.current.layouts !== layouts
    ) {
      const shifts = new Map<string, { shift: number; start: number }>();
      const groups = new Map<number, number>();
      let shift = 0;
      let start = 0;
      let previousStart = 0;
      presentation.rows.forEach((row, i) => {
        const exit = presentation.exiting.get(row.key);
        if (exit?.fading) {
          const ownStart = exit.start + CHECKED_MS;
          // A subtree completed together fades in place. Only an earlier,
          // separate completion moves a row that is itself now exiting.
          const otherShift = shift - (groups.get(ownStart) ?? 0);
          if (otherShift)
            shifts.set(row.key, {
              shift: otherShift,
              start: start === ownStart ? previousStart : start,
            });
          const size = layouts[i]?.size ?? 36;
          shift -= size;
          groups.set(ownStart, (groups.get(ownStart) ?? 0) - size);
          if (ownStart > start) {
            previousStart = start;
            start = ownStart;
          } else if (ownStart < start)
            previousStart = Math.max(previousStart, ownStart);
        } else if (shift) shifts.set(row.key, { shift, start });
      });
      plan.current = { presentation, layouts, shifts, shift, start };
    }
    const active = new Set<Animation>();
    const now = performance.now();
    const animate = (
      el: HTMLElement,
      target: string,
      start: number,
      opacity = false,
    ) => {
      const deadline = start + EXIT_MS;
      const property = opacity ? "opacity" : "transform";
      const properties = motions.current.get(el) ?? {};
      const old = properties[property];
      const computed = getComputedStyle(el);
      const currentY = new DOMMatrixReadOnly(computed.transform).m42;
      const base = opacity
        ? 0
        : el.getBoundingClientRect().y + window.scrollY - currentY;
      if (
        old?.target === target &&
        old.deadline === deadline &&
        Math.abs(old.base - base) < 0.01
      ) {
        active.add(old.animation);
        return;
      }
      // A layout change retargets from the current visual position, compensating
      // for a changed normal-flow base (notably Add node after a partial exit).
      const from = opacity
        ? computed.opacity
        : `translateY(${currentY + (old ? old.base - base : 0)}px)`;
      old?.animation.cancel();
      const animation = el.animate(
        opacity
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { transform: old ? from : el.style.transform || "translateY(0)" },
              { transform: target },
            ],
        {
          duration: old ? Math.max(0, deadline - now) : EXIT_MS,
          easing: opacity ? EXIT_EASE : MOVE_EASE,
          fill: "forwards",
        },
      );
      // Setting currentTime alone leaves a pending animation waiting for the
      // compositor's next frame. Anchor its start explicitly so a busy frame
      // cannot leave movement behind the fixed visual-removal deadline.
      animation.startTime =
        Number(document.timeline.currentTime) -
        (old ? 0 : Math.max(0, now - start));
      properties[property] = { animation, target, deadline, base };
      motions.current.set(el, properties);
      active.add(animation);
    };
    for (const [key, span] of elements) {
      const li = span?.closest("li");
      if (!li) continue;
      const exit = presentation.exiting.get(key);
      if (exit?.fading) animate(li, "0", exit.start + CHECKED_MS, true);
      const move = plan.current.shifts.get(key);
      if (move) {
        const position = new DOMMatrixReadOnly(li.style.transform).m42;
        animate(li, `translateY(${position + move.shift}px)`, move.start);
      }
    }
    const add =
      listRef.current?.parentElement?.querySelector<HTMLElement>(
        "[data-outline-add]",
      );
    if (add && plan.current.shift)
      animate(add, `translateY(${plan.current.shift}px)`, plan.current.start);
    // Cancel fill-forwards only after React commits canonical positions, or
    // immediately on undo/collapse/deletion. Disconnected elements are released.
    for (const [el, properties] of motions.current) {
      for (const property of ["opacity", "transform"] as const) {
        const motion = properties[property];
        if (motion && !active.has(motion.animation)) {
          motion.animation.cancel();
          delete properties[property];
        }
      }
      if (!properties.opacity && !properties.transform)
        motions.current.delete(el);
    }
  };

  return { ...presentation, animateMounted };
}
