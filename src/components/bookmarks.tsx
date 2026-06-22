import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { Bookmark, Star } from "lucide-react";
import { nodesCollection } from "../data/collection";
import { useTree } from "../data/useTree";
import { toggleBookmark } from "../data/mutations";
import { capture } from "../data/history";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Separator } from "./ui/separator";

/**
 * Bookmark controls split across the header's two action groups (ADR 0011):
 *
 *  - {@link BookmarkStar} is **node-scoped** — it acts on the current zoom view
 *    (the single node you're looking at), so it lives in the focused-node group.
 *  - {@link BookmarksMenu} is **global** — it lists every bookmark and navigates,
 *    so it lives with the other app-wide controls.
 *
 * Bookmark state lives on the node (`bookmarkedAt`), so deleting a node drops
 * its bookmark for free.
 */

/**
 * Star toggle: pins/unpins the CURRENT zoom view. Renders nothing on home,
 * where there is no single node to act on. Owns the trailing vertical divider
 * that separates the node group from the global group, so the divider appears
 * and disappears together with the star (no dangling separator on home).
 */
export function BookmarkStar() {
  const { index } = useTree();
  // Loose params: `nodeId` is present on /$nodeId, absent on / (home).
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const current = rootId ? (index.byId.get(rootId) ?? null) : null;
  if (!current) return null;

  const isBookmarked = current.bookmarkedAt != null;

  return (
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
  );
}

/**
 * Bookmarks popover: the list of every bookmarked node, newest pinned first.
 * Reads the collection directly (a flat filter + sort) rather than building a
 * tree index it doesn't need. Each row navigates to that node's zoom view via a
 * plain route nav -- no morph, since a popover row isn't the dot the zoom
 * animation pivots on.
 */
export function BookmarksMenu() {
  const { data } = useLiveQuery(nodesCollection);
  const [open, setOpen] = useState(false);

  const bookmarks = useMemo(
    () =>
      (data ?? [])
        .filter((n) => n.bookmarkedAt != null)
        .sort((a, b) => (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)),
    [data],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-sm">
            <Bookmark />
            <span className="sr-only">Bookmarks</span>
          </Button>
        }
      />
      <PopoverContent align="end" className="gap-1 p-1.5">
        {bookmarks.length === 0 ? (
          <p className="px-2 py-3 text-center text-muted-foreground">
            No bookmarks yet. Open a bullet and tap the star to pin it.
          </p>
        ) : (
          <ul className="flex flex-col">
            {bookmarks.map((n) => (
              <li key={n.id}>
                <Link
                  to="/$nodeId"
                  params={{ nodeId: n.id }}
                  onClick={() => setOpen(false)}
                  className="block truncate rounded-md px-2 py-1.5 hover:bg-muted"
                >
                  {n.text.trim() || "Untitled"}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
