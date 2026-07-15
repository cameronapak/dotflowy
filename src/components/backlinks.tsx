// Backlinks chrome (ADR 0032) -- CORE, not a plugin seam: it joins the mirror
// "appears in N places" family (one grammar for "this node's edges"), and core
// chrome may depend on the core-known `[[id]]` format (src/data/node-links.ts)
// but never on the node-links plugin. No `title:below` seam is invented for it
// (ADR 0031's bar: a seam is extracted when a second consumer proves it).
//
// Shape is Notion's, not Roam's: a quiet "{n} backlinks" line under the zoomed
// title, rendering NOTHING at zero, opening a mirror-places-style jump list on
// click. Zoom-only on purpose -- no per-row backlink chrome in the list (it
// would fight the node-decoration budget for information rarely needed
// mid-list).

import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Link2 } from "lucide-react";
import { useState } from "react";

import type { Node } from "../data/tree";

import { flattenNodeText } from "../data/node-links";
import { useBacklinkCount, useTreeIndex } from "../data/tree-store";
import { requestFlashAfterNav } from "./flash-node";
import { Crumbs, crumbsFor } from "./mirror-places";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * The "{n} backlinks" affordance for the zoomed node. Mounted by OutlineEditor
 * directly under the ZoomedTitle; subscribes to a primitive count (the reverse
 * index bucket's length), so it re-renders only when the count changes and
 * renders null -- zero chrome, zero dialog -- while nothing links here.
 */
export function Backlinks({ nodeId }: { nodeId: string }) {
  const count = useBacklinkCount(nodeId);
  const [open, setOpen] = useState(false);

  if (count === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 mb-3 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Link2 className="size-3.5" aria-hidden="true" />
        {count} backlink{count === 1 ? "" : "s"}
      </button>
      {open && (
        <BacklinksDialog nodeId={nodeId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * The jump list: one entry per REFERRING node (deduped by the reverse index),
 * its flattened text + disambiguating breadcrumb. Jump semantics mirror a
 * mirror instance's: zoom the referrer's PARENT and flash the referring row, so
 * you see the link in its surroundings (zooming the referrer itself would show
 * its text as a page title -- the link would be easy to miss).
 *
 * Mounted only while open, so its whole-index subscription (live text while the
 * list is up) never rides the editor's render path.
 */
function BacklinksDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const index = useTreeIndex();
  const navigate = useNavigate();

  const referrers: Node[] = (index.linksByTarget.get(nodeId) ?? [])
    .map((id) => index.byId.get(id))
    .filter((n): n is Node => n != null);

  function goTo(referrer: Node) {
    onClose();
    // Show the referring bullet in context: zoom its parent (Home when
    // top-level) and flash the row once that view mounts -- the mirror-places
    // jump grammar (scrollRowIntoView brings a windowed row on screen).
    requestFlashAfterNav(referrer.id);
    const parent = referrer.parentId;
    if (parent == null) navigate({ to: "/" });
    else navigate({ to: "/$nodeId", params: { nodeId: parent } });
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="min-w-0 px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <Link2 className="size-4 shrink-0 text-muted-foreground" />
            {referrers.length} backlink{referrers.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription className="text-left">
            Nodes whose text links here.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] min-w-0 scroll-fade overflow-y-auto overscroll-contain px-2 pb-2">
          {referrers.map((referrer) => (
            <li key={referrer.id}>
              <button
                type="button"
                onClick={() => goTo(referrer)}
                className="grid w-full grid-cols-[1fr_auto] items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm">
                    {flattenNodeText(index, referrer.text).trim() || "Untitled"}
                  </span>
                  <Crumbs crumbs={crumbsFor(index, referrer.id)} />
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
