// Provenance plugin: mark nodes an agent created (via the MCP server) so the
// user can tell them apart from what they typed themselves. Built entirely on
// existing seams — one Seam F node slot in BOTH render paths (list bullet +
// zoomed title), like the daily date badge.
//
// Data model: the write-once `origin` field on the Node (null = the user typed
// it, which is every client-side create and every pre-provenance row; a harness
// name like "Claude" = an agent made it over MCP, stamped server-side at the one
// write choke point in worker/outline-ops.ts). Provenance is set at creation and
// only ever READ here — never a semantic branch, purely display. No side
// collection, no per-node subscription: `origin` never changes after birth, so
// reading it off the node the slot is handed is enough.
//
// Visual: a small reserved-indigo diamond just before the text — indigo reads as
// "system / not-you" without the alarm of red/green, and a diamond (not a ring)
// so it can't be misread as a second bullet dot. Static (no animation: an agent
// marker that pulsed would read as exactly the AI-generated noise we're avoiding)
// and single-hued (the one accessory). The harness name + creation time show on
// hover; the mark itself stays quiet.

import { SparkleIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/plugins/kit";
import type { Node } from "../../data/tree";
import { definePlugin } from "../types";
import { cn } from "@/lib/utils";

/** A compact "when", for the hover attribution. Set-once at creation, so this is
 *  read at render time against the wall clock — good enough for a tooltip. */
function relativeTime(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

// Two homes (Seam F): the list bullet (`placement="row"`) and the zoomed page
// title (`placement="title"`). The only difference is the vertical nudge onto
// the text baseline — the row top-aligns its children (so the small mark needs a
// push down), the flex-centered title needs a touch more. Renders nothing for a
// user-authored node (`origin` null), which is the overwhelming majority.
function ProvenanceMark({
  node,
  placement,
}: {
  node: Node;
  placement: "row" | "title";
}) {
  if (!node.origin) return null;
  const label = `Created by ${node.origin} · ${relativeTime(node.createdAt)}`;
  return (
    <Tooltip>
      <TooltipTrigger>
        <SparkleIcon
          className={cn([
            "text-muted-foreground",
            // Row vertical alignment is the shared `.outline-row [data-origin]`
            // rule (scales with reading size, ADR 0029); only fix the icon size.
            placement === "row" && "size-4",
            placement === "title" && "size-5 mt-2 mr-2",
          ])}
          aria-label={label}
          data-origin={node.origin}
        />
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export default definePlugin({
  id: "provenance",

  // Seam F (row + title): the origin marker, between the bullet dot and the text
  // in both render paths. Absent on user-authored nodes (ProvenanceMark returns
  // null), so it costs a null check per non-agent row and nothing else.
  slots: [
    {
      id: "provenance-mark-row",
      position: "row:before-text",
      render: (node) => <ProvenanceMark node={node} placement="row" />,
    },
    {
      id: "provenance-mark-title",
      position: "title:before-text",
      render: (node) => <ProvenanceMark node={node} placement="title" />,
    },
  ],
});
