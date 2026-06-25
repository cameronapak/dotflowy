import { Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { subheaderSlots } from "../plugins/registry";
import type { PluginContext } from "../plugins/types";
import { cn } from "@/lib/utils";

/**
 * Contextual chrome band below the main header. Plugin subheader slots render
 * here (the tag filter bar today). Collapses away entirely when every slot
 * renders no DOM (a slot may return a component that renders null — the band
 * keys off childElementCount, not the React element being non-null). Sticks
 * with the header as one unit. Border spans the full viewport (inner row is
 * centered like Header); animated height measures the shell so the border
 * isn't clipped.
 */
export function Subheader({
  getCtx,
}: {
  getCtx?: () => PluginContext;
}) {
  const reduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);

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
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="overflow-hidden"
      aria-hidden={!open}
    >
      <div
        ref={shellRef}
        className={cn("bg-muted/30", open && "border-b border-border")}
      >
        <div
          ref={contentRef}
          role="region"
          aria-label="Active filters"
          className={cn(
            "mx-auto flex max-w-[720px] flex-wrap items-center gap-2",
            open && "px-6 py-2",
          )}
        >
          {subheaderSlots.map((s) => (
            <Fragment key={s.id}>{s.render(getCtx)}</Fragment>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
