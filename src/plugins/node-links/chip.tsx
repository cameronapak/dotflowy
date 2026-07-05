// The node-link chip, as REAL TSX (ADR 0006 -- Seam A's React mode), mounted
// inside a `<dotflowy-widget>` atom. This is WHY the token is a widget and not
// an `El` (ADR 0032): the source string `[[id]]` never changes when the TARGET
// is renamed, so the decorate cache would freeze a plain-El label -- but a
// mounted component subscribes via useNode(targetId) and re-renders the live
// text on its own. The atom is `contenteditable="false"`; the caret jumps over
// it and copy reads back `data-src` (the raw token).
//
// A missing target (the node was deleted -- ADR 0032 degrades, never blocks)
// renders a ghosted "missing link" chip; undoing the delete restores the target
// and this heals automatically (the id-pointer model paying off).

import { Link2, Unlink } from "lucide-react";
import { buildTrail } from "../../data/tree";
import { getTreeIndex, useNode } from "../../data/tree-store";
import { flattenInline } from "../../data/inline-text";
import { linkTargetId, linkedNodeLabel } from "../../data/node-links";
import type { WidgetProps } from "../types";

/** The label clamp (ADR 0032): node text can be a paragraph; the chip shows a
 *  readable head, the hover breadcrumb carries the rest. */
const MAX_LABEL = 40;

function clamp(label: string): string {
  return label.length > MAX_LABEL
    ? label.slice(0, MAX_LABEL).trimEnd() + "…"
    : label;
}

export function NodeLinkChip({ source }: WidgetProps) {
  const targetId = linkTargetId(source);
  const target = useNode(targetId);

  if (!target) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1 align-baseline text-[0.95em] text-muted-foreground line-through decoration-muted-foreground/50 select-none"
        title="This node no longer exists"
      >
        <Unlink className="size-[0.85em] shrink-0" aria-hidden="true" />
        missing link
      </span>
    );
  }

  const label = clamp(linkedNodeLabel(target.text).trim()) || "Untitled";
  // The only way to see where a link points without navigating (the chip is an
  // atom, no reveal state): a hover tooltip with the target's breadcrumb.
  // Computed at render from the shared index; re-renders ride the target's own
  // useNode subscription, so an ancestor rename may lag until then -- a
  // low-stakes tooltip staleness, accepted (ADR 0032).
  const crumbs = buildTrail(getTreeIndex(), targetId)
    .slice(0, -1)
    .map((n) => flattenInline(n.text).trim() || "Untitled");
  const title = crumbs.length > 0 ? crumbs.join(" › ") : "Home";

  return (
    <span
      className="inline-flex max-w-full items-center gap-1 align-baseline text-[0.95em] font-medium text-primary underline decoration-primary/35 underline-offset-2 cursor-pointer select-none hover:decoration-primary"
      title={title}
    >
      <Link2 className="size-[0.85em] shrink-0 opacity-80" aria-hidden="true" />
      {label}
    </span>
  );
}
