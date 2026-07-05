// Child-count plugin. A collapsed bullet shows how many items it hides -- a
// small trailing count, Workflowy-style. First consumer of the trailing
// decoration seam (`row:after-text`, ADR 0031): it proves the budget -> overflow
// -> panel chain has a real user, and that a plugin reaches UI through the
// curated kit (never `components/ui` directly).
//
// Seams contributed: F (node slot, row-only).

import { Badge } from "@/plugins/kit";
import { useVisibleChildIds } from "../../data/tree-store";
import { definePlugin } from "../types";
import type { Node } from "../../data/tree";

// Count EVERY direct child (a collapsed node hides all of them), so the badge
// reads "N items inside" regardless of the hide-completed view. A stable module
// constant keeps `useVisibleChildIds`'s snapshot cache warm (a fresh closure per
// render would defeat it -- ADR 0014).
const NONE_HIDDEN = () => false;

// Reactive, per-parent scoped (ADR 0014): only re-renders when THIS node's child
// list changes, never on an unrelated keystroke. A leaf renders nothing.
function ChildCountBadge({ nodeId }: { nodeId: string }) {
  const childIds = useVisibleChildIds(nodeId, NONE_HIDDEN);
  const count = childIds.length;
  if (count === 0) return null;
  return (
    <Badge
      variant="secondary"
      // pointer-events-none: a display signifier, not a control -- clicks fall
      // through to the row (the chevron/dot own expand/zoom). No plugin CSS: the
      // look rides Tailwind utilities on a kit primitive (ADR 0031).
      className="pointer-events-none h-[18px] rounded-full px-1.5 text-[11px] font-normal tabular-nums text-muted-foreground"
      title={`${count} hidden item${count === 1 ? "" : "s"}`}
    >
      {count}
    </Badge>
  );
}

export default definePlugin({
  id: "child-count",
  slots: [
    {
      // Row only: the zoomed title is never "collapsed" in view (you are looking
      // AT its children), so a hidden-count there would be wrong. This is a
      // deliberate single-path decoration, not a mirror-drift.
      id: "child-count:row",
      position: "row:after-text",
      render: (node: Node) =>
        node.collapsed ? <ChildCountBadge nodeId={node.id} /> : null,
    },
  ],
});
