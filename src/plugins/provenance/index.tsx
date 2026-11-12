// Provenance plugin: mark nodes an agent created (via the MCP server) so the
// user can tell them apart from what they typed themselves. Built entirely on
// existing seams — one Seam F node slot in BOTH render paths (list bullet +
// zoomed title), like the daily date badge.
//
// Data model: the write-once `origin` field on the Node (null = the user typed
// it, which is every client-side create and every pre-provenance row; an app
// name like "Claude" = an agent made it over MCP, from the write tool's required
// `sourceApp`, stamped server-side at the one write choke point in
// worker/outline-ops.ts). Provenance is set at creation and only ever READ here
// — never a semantic branch, purely display. No side collection, no per-node
// subscription: `origin` never changes after birth, so reading it off the node
// the slot is handed is enough.
//
// Visual (ADR 0081): the source app's own logo just before the text, so a reader
// sees WHICH app wrote a node, not only that an agent did. Muted and the same
// 16px slot for every app, so rows never shift; OpenAI's and xAI's marks take
// the text color their brand rules require. An unlisted app gets a bot, not the
// old sparkle, which reads as Gemini's star at this size. Static, no animation.
// The app name + creation time show on hover.

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/plugins/kit";

import type { Node } from "../../data/tree";

import { definePlugin } from "../types";
import { PROVENANCE_FILTER_OPERATORS } from "./filter-operators";
import { markFor, SourceAppGlyph } from "./marks";

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
  const mark = markFor(node.origin);
  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          role="img"
          className={cn([
            "inline-flex shrink-0 items-center justify-center",
            mark.fullTone ? "text-foreground" : "text-muted-foreground",
            // Row vertical alignment is the shared `.outline-row [data-origin]`
            // rule (scales with reading size, ADR 0029); only fix the box size.
            placement === "row" && "h-4 min-w-4",
            placement === "title" && "mt-2 mr-2 h-5 min-w-5",
          ])}
          aria-label={label}
          data-origin={node.origin}
        >
          <SourceAppGlyph mark={mark} placement={placement} />
        </span>
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

  // Query filter (ADR 0047 §4): `is:agent` -- nodes an agent created over MCP
  // (`origin` non-null), an axis Workflowy can't offer. Provenance owns the
  // field, so it owns the operator; it joins the `is` key alongside the core
  // kind values and todos' `is:complete` without collision.
  filterOperators: PROVENANCE_FILTER_OPERATORS,
});
