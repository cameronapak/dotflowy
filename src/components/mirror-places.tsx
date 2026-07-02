import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, CopyPlus } from "lucide-react";
import { useTree } from "../data/useTree";
import {
  buildTrail,
  trueSourceOf,
  type Node,
  type TreeIndex,
} from "../data/tree";
import { stripLinks } from "../data/links";
import { requestFlashAfterNav } from "./flash-node";
import { setMirrorPlacesOpener } from "./mirror-places-opener";
import { Badge } from "./ui/badge";
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
    <MirrorPlacesInner sourceId={sourceId} onClose={() => setSourceId(null)} />
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
  const source = sourceId
    ? index.byId.get(trueSourceOf(index, sourceId))
    : null;

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
  const title = source ? stripLinks(source.text).trim() || "Untitled" : "";

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
      {/* DialogContent is a grid; its items need min-w-0 or their nowrap
          (truncate) text sets the track's min width and blows the dialog open
          past its max-w. sm:max-w-md (not max-w-md) keeps the base
          max-w-[calc(100%-2rem)] mobile guard out of tailwind-merge's way. */}
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="min-w-0 px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <CopyPlus className="size-4 shrink-0 text-muted-foreground" />
            Appears in {places.length} places
          </DialogTitle>
          <DialogDescription className="line-clamp-4 text-left">
            {title}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] min-w-0 overflow-y-auto overscroll-contain px-2 pb-2">
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

/** Ancestor texts top-down, excluding the node itself -- the disambiguating
 *  breadcrumb. Empty = the occurrence sits at the top level. */
function crumbsFor(index: TreeIndex, id: string): string[] {
  return buildTrail(index, id)
    .slice(0, -1)
    .map((n) => stripLinks(n.text).trim() || "Untitled");
}

function PlaceRow({
  place,
  crumbs,
  onSelect,
}: {
  place: Place;
  crumbs: string[];
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="grid grid-cols-[auto_1fr_auto] w-full items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
      >
        <Badge
          variant={place.isSource ? "outline" : "secondary"}
          className="w-16 justify-center"
        >
          {place.isSource ? "Source" : "Mirror"}
        </Badge>
        <Crumbs crumbs={crumbs} />
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

/**
 * One-line breadcrumb that truncates from the HEAD, not the tail. Deep trails
 * collapse to "first › … › parent" (the immediate parent disambiguates best,
 * so the tail is what must survive; the full trail rides the title tooltip).
 * The parent crumb is rigid (shrink-0, capped at 60% so a giant name can't
 * evict the trail entirely); ancestors shrink first, down to a min-w-6 sliver.
 * End-truncating the joined string would hide exactly the crumb that tells
 * the places apart.
 */
function Crumbs({ crumbs }: { crumbs: string[] }) {
  if (crumbs.length === 0) {
    return <span className="truncate text-sm text-muted-foreground">Home</span>;
  }
  const shown =
    crumbs.length <= 2
      ? crumbs
      : [...crumbs.slice(0, 1), "…", ...crumbs.slice(-1)];
  const last = shown.length - 1;
  return (
    <span
      title={crumbs.join(" › ")}
      className="flex min-w-0 items-center text-sm text-muted-foreground"
    >
      {shown.map((crumb, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span
              aria-hidden="true"
              className="shrink-0 px-1 text-muted-foreground/50"
            >
              ›
            </span>
          )}
          <span
            className={
              i < last
                ? "min-w-6 shrink-[999] truncate"
                : shown.length === 1
                  ? "min-w-0 truncate"
                  : "min-w-0 max-w-[60%] shrink-0 truncate"
            }
          >
            {crumb}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
