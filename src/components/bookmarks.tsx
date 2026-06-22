import { useParams } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useTree } from "../data/useTree";
import { toggleBookmark } from "../data/mutations";
import { capture } from "../data/history";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

/**
 * Bookmark **creation** control for the header.
 *
 * A bookmark is a saved zoom view (`bookmarkedAt` on the node), so deleting a
 * node drops its bookmark for free (ADR 0011). Originally this file also owned
 * a header popover that *listed* bookmarks; that browse surface folded into the
 * node quick-switcher's empty state (ADR 0012), so the popover was removed
 * (ADR 0013) as redundant. What remains is the star that pins/unpins the
 * current view -- the one thing the switcher can't do.
 */

/**
 * Star toggle: pins/unpins the CURRENT zoom view. Renders nothing on home,
 * where there is no single node to act on. Owns the trailing vertical divider
 * that separates the focused-node group from the global group, so the divider
 * appears and disappears together with the star (no dangling separator on home).
 */
export function BookmarkStar() {
  const { index } = useTree();
  // Loose params: `nodeId` is present on /$nodeId, absent on / (home).
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const current = rootId ? (index.byId.get(rootId) ?? null) : null;
  if (!current) return null;

  const isBookmarked = current.bookmarkedAt != null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        data-state={isBookmarked ? "on" : "off"}
        className="data-[state=on]:bg-muted data-[state=on]:text-foreground"
        aria-pressed={isBookmarked}
        onClick={() => {
          // One undo step; no focus change (bookmarking isn't an edit).
          capture(index, null);
          toggleBookmark(current.id, !isBookmarked);
        }}
      >
        <Star className={isBookmarked ? "fill-current" : ""} />
        <span className="sr-only">
          {isBookmarked ? "Remove bookmark" : "Bookmark this view"}
        </span>
      </Button>
      <Separator orientation="vertical" />
    </>
  );
}
