import { motion, useReducedMotion } from "motion/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import type { PluginContext } from "../plugins/types";

import { subheaderSlots } from "../plugins/registry";
import { QueryFilterBar } from "./query-filter";
import { SUBHEADER_EXPAND_MS } from "./subheader-expand";

/**
 * Contextual chrome band below the main header. Plugin subheader slots render
 * here (the tag filter bar today). Collapses away entirely when every slot
 * renders no DOM (a slot may return a component that renders null — the band
 * keys off childElementCount, not the React element being non-null). Sticks
 * with the header as one unit. Border spans the full viewport (inner row is
 * centered like Header); animated height measures the shell so the border
 * isn't clipped.
 */
export function Subheader({ getCtx }: { getCtx?: () => PluginContext }) {
  const reduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  // The band mounts with `open=false, height=0`, then the layout effects below
  // measure and flip it to full height in the SAME pre-paint commit. Without
  // this guard that flip animates 0->full every time the editor remounts (a day
  // switch remounts the whole editor, subheader included) — the band visibly
  // "reopens" and shoves the outline down. So: SNAP on the initial mount (paint
  // the measured height with no animation), and only animate open/close changes
  // that happen AFTER first paint — e.g. the `?q=` filter bar appearing while
  // the user stays on a page. A ref (not state) is right because the value is
  // only read at the NEXT render, which a real open/close change already triggers.
  //
  // Why NOT a bare mount `useEffect(() => { ref = true }, [])`: it flips too
  // early. `measure()` runs in a `useLayoutEffect` and calls `setOpen`/
  // `setHeight`, which schedules a SYNCHRONOUS re-render — and React flushes any
  // PENDING PASSIVE EFFECTS before that re-render begins. So the mount's passive
  // effect body runs BEFORE the height-setting render, the guard is already true
  // when `animate` changes to the measured height, and the band eases 0->full on
  // the SUBHEADER_EXPAND_MS curve — the exact bug we're killing. A double
  // `requestAnimationFrame` genuinely defers the flip past the first painted
  // frame (a single rAF can fire before paint completes in some engines), so the
  // mount's measure-and-snap has landed opaque before the guard opens.
  const hasPaintedRef = useRef(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        hasPaintedRef.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  // Kept as useCallback (not redundant despite React Compiler): it's a
  // dependency of the useLayoutEffects below, so oxlint's exhaustive-deps gate
  // (compiler-unaware) requires a stable identity. Removing it trips two
  // correctness errors. See react-doctor/react-compiler-no-manual-memoization.
  const measure = useCallback(() => {
    const content = contentRef.current;
    const shell = shellRef.current;
    if (!content || !shell) return;
    const has = content.childElementCount > 0;
    setOpen(has);
    // offsetHeight on the bordered shell — scrollHeight on the inner row
    // clipped the bottom border under overflow-hidden.
    setHeight(has ? shell.offsetHeight : 0);
  }, []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    const mo = new MutationObserver(measure);
    mo.observe(content, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);

  useLayoutEffect(() => {
    measure();
  }, [open, measure]);

  if (!getCtx) return null;

  return (
    <motion.div
      initial={false}
      animate={
        reduceMotion
          ? { height: open ? "auto" : 0 }
          : { height: open ? height : 0, opacity: open ? 1 : 0 }
      }
      transition={
        hasPaintedRef.current
          ? { duration: SUBHEADER_EXPAND_MS / 1000, ease: "easeOut" }
          : { duration: 0 }
      }
      className="overflow-hidden bg-background"
      aria-hidden={!open}
    >
      {/* bg-background under the translucent tint: the band is sticky, so a
          see-through background lets scrolled bullets bleed into the filter
          row. The tint keeps its look but now composites opaque. */}
      <div
        ref={shellRef}
        className={cn("bg-muted/30", open && "border-b border-border")}
      >
        <section
          ref={contentRef}
          aria-label="Active filters"
          className={cn(
            "mx-auto flex max-w-[720px] flex-wrap items-center gap-2",
            open && "px-6 py-2 max-sm:px-4",
          )}
        >
          {/* The `?q=` filter is CORE chrome (ADR 0047 §6); it sits beside the
              plugin subheader slots the way core commands sit beside plugin
              commands. Renders nothing when idle, so the band still collapses. */}
          <QueryFilterBar />
          {subheaderSlots.map((s) => (
            <Fragment key={s.id}>{s.render(getCtx)}</Fragment>
          ))}
        </section>
      </div>
    </motion.div>
  );
}
