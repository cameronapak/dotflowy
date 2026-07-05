import { Fragment, useEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { slotsAt } from "../plugins/registry";
import type { Node } from "../data/tree";
import type { PluginContext, SlotPosition } from "../plugins/types";

/**
 * The trailing node-decoration zone (Seam F `*:after-text` -- ADR 0031, the
 * anti-ugly node budget). A plugin's rich decorations render at the row's
 * trailing edge, but the CORE caps how much of the bullet they may occupy: the
 * zone is clipped to `--node-deco-budget` (styles.css) and, when the content
 * exceeds it, a trailing fade + an overflow affordance signal "there's more".
 * Freedom is capped by SPACE, not vocabulary -- an author uses any component
 * they like; the outline surface still can't be crowded out.
 *
 * Overflow is detected as a BOOLEAN, never a per-child count. A count would need
 * per-decoration width math and would flicker as async widgets (favicons,
 * avatars) settle; a boolean just flips once when content crosses the budget.
 * One `ResizeObserver` watches the content track (its width changes when a
 * decoration loads in) AND the zone (its width changes when a narrow viewport
 * squeezes the row) -- but NOT scroll: the windowed row's `translateY`
 * reposition resizes neither element, so the observer stays silent on the hot
 * path (ADR 0019 / ADR 0014).
 *
 * Rendered as spans (not divs) so the same component is valid inside both render
 * paths -- the list row's `<li>` and the zoomed title's phrasing-only `<h2>`.
 *
 * Ships DORMANT: no plugin registers an `*:after-text` slot yet, so `slotsAt`
 * is empty and the component returns null with zero DOM/observer cost. The first
 * trailing decoration + the overflow panel land in later build-plan steps.
 */
export function NodeDecorations({
  node,
  position,
  getCtx,
  onExpand,
}: {
  node: Node;
  position: Extract<SlotPosition, "row:after-text" | "title:after-text">;
  /** The stable PluginContext factory the row passes everywhere. */
  getCtx: () => PluginContext;
  /** Open the node's full-detail panel showing the decorations that overflowed
   *  the budget. Wired to the Tier-3 panel host in a later step; until a handler
   *  is passed, the overflow affordance stays hidden (a clip + fade, no button
   *  that goes nowhere). */
  onExpand?: () => void;
}) {
  // The compiled-in plugin set makes this a load-time constant, so a node with
  // no trailing decorations pays nothing (no zone, no observer). Today every
  // `*:after-text` position is empty -- the seam is dormant.
  const slots = slotsAt(position);
  const hasSlots = slots.length > 0;

  const zoneRef = useRef<HTMLSpanElement | null>(null);
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const zone = zoneRef.current;
    const track = trackRef.current;
    if (!zone || !track) return;
    const measure = () => {
      // +1 absorbs sub-pixel rounding so a flush fit isn't read as overflow.
      const next = track.offsetWidth > zone.clientWidth + 1;
      setOverflowing((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(zone);
    ro.observe(track);
    measure();
    return () => ro.disconnect();
  }, [hasSlots]);

  if (!hasSlots) return null;

  return (
    <span className="node-deco" data-overflowing={overflowing || undefined}>
      <span className="node-deco-zone" ref={zoneRef}>
        <span className="node-deco-track" ref={trackRef}>
          {slots.map((slot) => (
            <Fragment key={slot.id}>{slot.render(node, getCtx)}</Fragment>
          ))}
        </span>
      </span>
      {overflowing && onExpand && (
        <button
          type="button"
          className="node-deco-more touch-hitbox"
          aria-label="Show all decorations"
          title="Show all"
          onClick={onExpand}
          tabIndex={-1}
        >
          <Ellipsis size={14} />
        </button>
      )}
    </span>
  );
}
