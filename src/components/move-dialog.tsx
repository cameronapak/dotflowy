import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import { BookmarkIcon, HomeIcon } from "lucide-react";
import { toast } from "sonner";
import { useTree } from "../data/useTree";
import { buildTrail, childrenOf, type Node, type TreeIndex } from "../data/tree";
import { moveNode } from "../data/mutations";
import { runStructural } from "../data/structural";
import { searchAliases, searchAnnotation } from "../plugins/registry";
import { requestFlashAfterNav } from "./flash-node";
import { capture, drop } from "../data/history";
import { cn } from "@/lib/utils";
import { setMoveDialogOpener } from "./move-dialog-opener";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

/**
 * `/move` destination picker: a focused fuzzy search over every node, plus a
 * "Home" entry, that reparents the chosen node as the **last child** of the
 * picked target (or a top-level node for Home). Mirrors `node-switcher.tsx`
 * (self-contained, single mount, module-level opener), but it *acts* -- it runs
 * the `moveNode` mutation -- rather than only navigating.
 *
 * The empty-query state lists **bookmarks** (same as the quick-switcher), since
 * the usual move target is a saved view -- so the common case is a single pick,
 * no typing. Typing falls back to the full fuzzy search over every node.
 *
 * After the move it stays put and fires a toast confirming the destination
 * (with a "Go" action to jump there on demand) -- moving a node shouldn't yank
 * you away from where you were working.
 */

const FUSE_OPTIONS: IFuseOptions<Node> = {
  // Plus plugin-contributed aliases (Seam J) so `/move` -> "today" finds the
  // daily note despite its full-date text. Matched, never highlighted
  // (textMatchIndices keeps only the "text" key). See ADR 0022.
  keys: ["text", { name: "aliases", getFn: (n) => searchAliases(n) }],
  includeMatches: true,
  // Match late in the string too, so "notes" finds "Weekly team notes" (ADR 0012).
  ignoreLocation: true,
  threshold: 0.3,
  minMatchCharLength: 2,
};

/** A destination row: a node, plus its Fuse match ranges when searched. */
interface Hit {
  node: Node;
  matches?: readonly FuseResultMatch[];
}

const RESULT_LIMIT = 50;

const BOOKMARKS_HEADING = (
  <div className="flex items-center gap-1">
    <BookmarkIcon className="size-4" />
    Bookmarks
  </div>
);

/**
 * Outer shell: owns open/query/target state and registers the opener, but reads
 * NO data. The data-driven dialog ({@link MoveDialogInner}, which calls
 * `useTree`) is mounted client-only -- this lives in `__root.tsx`, outside the
 * route error boundary, so its `useLiveQuery` would otherwise hard-fail the `/`
 * prerender (SPA mode, ADR 0004). Same guard as the quick-switcher.
 */
export function MoveDialog() {
  const [target, setTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  useEffect(() => {
    setMoveDialogOpener((nodeId) => {
      setTarget(nodeId);
      setQuery("");
    });
    return () => {
      setMoveDialogOpener(null);
    };
  }, []);

  if (!mounted) return null;

  return (
    <MoveDialogInner
      nodeId={target}
      onOpenChange={(next) => {
        if (!next) {
          setTarget(null);
          setQuery("");
        }
      }}
      query={query}
      setQuery={setQuery}
    />
  );
}

function MoveDialogInner({
  nodeId,
  onOpenChange,
  query,
  setQuery,
}: {
  nodeId: string | null;
  onOpenChange: (next: boolean) => void;
  query: string;
  setQuery: (q: string) => void;
}) {
  const { index } = useTree();
  const navigate = useNavigate();
  const open = nodeId !== null;

  // Candidate destinations: every node except the one being moved and its own
  // subtree (you can't move a branch into itself -- `moveNode` guards this too,
  // but listing those rows would be a dead press). Built only while open.
  const candidates = useMemo(() => {
    if (!nodeId) return [];
    const excluded = subtreeIds(index, nodeId);
    return Array.from(index.byId.values()).filter(
      (n) => !excluded.has(n.id) && n.text.trim() !== "",
    );
  }, [index, nodeId]);

  const fuse = useMemo(
    () => (open ? new Fuse(candidates, FUSE_OPTIONS) : null),
    [open, candidates],
  );

  const q = query.trim();

  // null => empty-query mode (show bookmarks, mirroring the quick-switcher).
  // Otherwise the Fuse hits over every candidate.
  const results = useMemo<Hit[] | null>(() => {
    if (!q || !fuse) return null;
    return fuse
      .search(q, { limit: RESULT_LIMIT })
      .map((r) => ({ node: r.item, matches: r.matches }));
  }, [q, fuse]);

  // Bookmarked destinations for the empty-query state, newest first. Drawn from
  // `candidates` (not all nodes), so the moved node and its own subtree are
  // already excluded -- you can't bookmark-jump a branch into itself.
  const bookmarks = useMemo(
    () =>
      candidates
        .filter((n) => n.bookmarkedAt != null)
        .sort((a, b) => (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)),
    [candidates],
  );

  // "Home" shows on an empty query or when the text looks like the word.
  const showHome = q === "" || "home".includes(q.toLowerCase());

  function move(targetId: string | null) {
    if (!nodeId) return;
    const movedId = nodeId;
    onOpenChange(false);
    const moved = runStructural(() => {
      capture(index, movedId);
      // Append as the last child of the destination (or last top-level for Home).
      const siblings = childrenOf(index, targetId);
      const after = siblings.length ? siblings[siblings.length - 1]!.id : null;
      return moveNode(index, movedId, targetId, after);
    });
    // A no-op move (already at the exact destination) still captured an undo
    // point; discard it so Cmd+Z doesn't look dead and redo history survives.
    if (!moved) {
      drop();
      return;
    }
    // Stay put -- moving shouldn't navigate you away. Confirm with a toast, and
    // offer a "Go" action to jump to the destination's zoom view on demand
    // (plain nav, no morph -- ADR 0003 -- since no pivot dot is involved).
    const dest =
      targetId === null
        ? "Home"
        : index.byId.get(targetId)?.text.trim() || "Untitled";
    toast.success(`Moved to ${dest}`, {
      action: {
        label: "Go",
        onClick: () => {
          // Flash + focus the moved node once the destination view mounts, so
          // it's easy to spot where it landed. See flash-node.ts.
          requestFlashAfterNav(movedId);
          if (targetId === null) {
            navigate({ to: "/" });
          } else {
            navigate({ to: "/$nodeId", params: { nodeId: targetId } });
          }
        },
      },
    });
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Move node"
      description="Choose a destination to move this node under"
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Move under..."
        />
        <CommandList>
          {showHome && (
            <CommandGroup heading="Top level">
              <CommandItem value="__home__" onSelect={() => move(null)}>
                <HomeIcon className="size-4 shrink-0 opacity-70" />
                <span>Home</span>
              </CommandItem>
            </CommandGroup>
          )}
          {results === null ? (
            bookmarks.length === 0 ? (
              <Hint>Type to search your nodes.</Hint>
            ) : (
              <CommandGroup heading={BOOKMARKS_HEADING}>
                {bookmarks.map((node) => (
                  <DestinationRow
                    key={node.id}
                    index={index}
                    node={node}
                    onSelect={move}
                  />
                ))}
              </CommandGroup>
            )
          ) : results.length === 0 ? (
            !showHome && <Hint>No matches.</Hint>
          ) : (
            <CommandGroup heading="Move under">
              {results.map(({ node, matches }) => (
                <DestinationRow
                  key={node.id}
                  index={index}
                  node={node}
                  matches={matches}
                  onSelect={move}
                />
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function DestinationRow({
  index,
  node,
  matches,
  onSelect,
}: {
  index: TreeIndex;
  node: Node;
  matches?: readonly FuseResultMatch[];
  onSelect: (nodeId: string) => void;
}) {
  // Ancestors, top-down, excluding the node itself -- the disambiguating
  // breadcrumb ("Work › Q3 › Notes"). Displayed, never searched (mirrors
  // node-switcher's ResultRow for consistency).
  const crumbs = buildTrail(index, node.id)
    .slice(0, -1)
    .map((n) => n.text.trim() || "Untitled")
    .join(" › ");

  const title = node.text.trim() || "Untitled";
  // Display-only plugin suffix (Seam J), mirroring node-switcher: "(Today)" on a
  // day note. Separate, un-highlighted span -- it isn't part of node.text.
  const annotation = searchAnnotation(node);

  return (
    <CommandItem value={node.id} onSelect={() => onSelect(node.id)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "truncate",
            node.completed && "text-muted-foreground line-through",
          )}
        >
          {highlight(title, textMatchIndices(matches))}
          {annotation && (
            <span className="ml-1 text-muted-foreground">({annotation})</span>
          )}
        </span>
        {crumbs && (
          <span className="truncate text-xs text-muted-foreground">
            {crumbs}
          </span>
        )}
      </div>
    </CommandItem>
  );
}

/** The `text`-key match's index ranges, if any. */
function textMatchIndices(
  matches?: readonly FuseResultMatch[],
): readonly [number, number][] | undefined {
  return matches?.find((m) => m.key === "text")?.indices;
}

/**
 * Wrap the matched character ranges in <mark>. Fuse ranges are inclusive and
 * sorted; everything outside them renders plain. Mirrors node-switcher.
 */
function highlight(
  text: string,
  ranges?: readonly [number, number][],
): ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([start, end]) => {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <mark
        key={`${start}-${end}`}
        className="rounded-[2px] bg-primary/20 px-px text-foreground"
      >
        {text.slice(start, end + 1)}
      </mark>,
    );
    last = end + 1;
  });
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** The node plus every descendant -- the set you can't move it into. */
function subtreeIds(index: TreeIndex, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const child of childrenOf(index, id)) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return ids;
}
