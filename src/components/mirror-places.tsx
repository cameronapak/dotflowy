import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CopyPlus } from "lucide-react";
import { useTree } from "../data/useTree";
import { buildTrail, trueSourceOf, type Node, type TreeIndex } from "../data/tree";
import { stripLinks } from "../data/links";
import { requestFlashAfterNav } from "./flash-node";
import { setMirrorPlacesOpener } from "./mirror-places-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * The "appears in N places" jump list (ADR 0022, slice 1d). Opened from a
 * mirror-count badge ({@link MirrorBadge}), it lists every occurrence of a
 * mirrored node -- the SOURCE plus each mirror INSTANCE -- and jumps to the one
 * you pick.
 *
 * Jump semantics, mirroring `/move`'s "Go": the SOURCE zooms to itself (you land
 * on the original, with its subtree). A MIRROR zooms to its parent's view and
 * flashes the instance row, so you see the copy highlighted in its surroundings
 * -- a mirror can't be a sane zoom ROOT (its children come from windowing the
 * source, so `childrenOf(instance)` is empty), which is why we zoom the parent.
 *
 * Self-contained and mounted once in `__root.tsx`, like the quick-switcher and
 * the move dialog; the badge reaches it via {@link openMirrorPlaces}. The data
 * view ({@link MirrorPlacesInner}, which calls `useTree`) is client-only so its
 * `useLiveQuery` can't hard-fail the `/` prerender (SPA mode, ADR 0004).
 */

interface Place {
  /** The source node, or one of its mirror instances. */
  node: Node;
  isSource: boolean;
}

export function MirrorPlaces() {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  useEffect(() => {
    setMirrorPlacesOpener((id) => setSourceId(id));
    return () => {
      setMirrorPlacesOpener(null);
    };
  }, []);

  if (!mounted) return null;

  return (
    <MirrorPlacesInner
      sourceId={sourceId}
      onClose={() => setSourceId(null)}
    />
  );
}

function MirrorPlacesInner({
  sourceId,
  onClose,
}: {
  sourceId: string | null;
  onClose: () => void;
}) {
  const { index } = useTree();
  const navigate = useNavigate();

  // Normalize whatever id we were handed (a content id is already the source,
  // but a raw mirror id flattens to it) and read the live source node.
  const source = sourceId ? index.byId.get(trueSourceOf(index, sourceId)) : null;

  const places = useMemo<Place[]>(() => {
    if (!source) return [];
    const list: Place[] = [{ node: source, isSource: true }];
    for (const id of index.mirrorsBySource.get(source.id) ?? []) {
      const n = index.byId.get(id);
      if (n) list.push({ node: n, isSource: false });
    }
    return list;
  }, [index, source]);

  const open = source !== null;
  const title = source
    ? stripLinks(source.text).trim() || "Untitled"
    : "";

  function goToPlace(place: Place) {
    onClose();
    if (place.isSource) {
      // The original: zoom it directly so you land inside its subtree.
      navigate({ to: "/$nodeId", params: { nodeId: place.node.id } });
      return;
    }
    // A mirror: zoom its parent and flash the instance once that view mounts
    // (scrollRowIntoView brings it on screen if windowed). Home for a top-level
    // mirror. See flash-node.ts / OutlineEditor's consumeFlashAfterNav.
    requestFlashAfterNav(place.node.id);
    const parent = place.node.parentId;
    if (parent == null) navigate({ to: "/" });
    else navigate({ to: "/$nodeId", params: { nodeId: parent } });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <CopyPlus className="size-4 shrink-0 text-muted-foreground" />
            Appears in {places.length} places
          </DialogTitle>
          <DialogDescription className="truncate text-left">
            {title}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] overflow-y-auto px-2 pb-2">
          {places.map((place) => (
            <PlaceRow
              key={place.node.id}
              place={place}
              crumbs={crumbsFor(index, place.node.id)}
              onSelect={() => goToPlace(place)}
            />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** Ancestors top-down, excluding the node itself -- the disambiguating
 *  breadcrumb. "Top level" when the occurrence sits at the root. */
function crumbsFor(index: TreeIndex, id: string): string {
  const crumbs = buildTrail(index, id)
    .slice(0, -1)
    .map((n) => stripLinks(n.text).trim() || "Untitled")
    .join(" › ");
  return crumbs || "Top level";
}

function PlaceRow({
  place,
  crumbs,
  onSelect,
}: {
  place: Place;
  crumbs: string;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
      >
        <span
          className={
            place.isSource
              ? "shrink-0 rounded-full bg-primary/15 px-2 text-[10px] font-medium leading-5 text-foreground"
              : "shrink-0 rounded-full bg-muted px-2 text-[10px] font-medium leading-5 text-muted-foreground"
          }
        >
          {place.isSource ? "Source" : "Mirror"}
        </span>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {crumbs}
        </span>
      </button>
    </li>
  );
}
