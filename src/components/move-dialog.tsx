import { useNavigate } from "@tanstack/react-router";
import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import { BookmarkIcon, HomeIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

import { capture, drop } from "../data/history";
import { mirrorManyNodes, moveManyNodes } from "../data/mutations";
import { runStructural } from "../data/structural";
import {
  buildTrail,
  childrenOf,
  trueSourceOf,
  type Node,
  type TreeIndex,
} from "../data/tree";
import { useTree } from "../data/useTree";
import { searchAliases, searchAnnotation } from "../plugins/registry";
import { requestFlashAfterNav } from "./flash-node";
import { setMoveDialogOpener, type MoveMode } from "./move-dialog-opener";
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
 * "Home" entry, that reparents the chosen node(s) as the **last child** of the
 * picked target (or a top-level node for Home). Mirrors `node-switcher.tsx`
 * (self-contained, single mount, module-level opener), but it *acts* -- it runs
 * the move mutation -- rather than only navigating.
 *
 * Drives ONE node (`/move`) or several at once -- node multi-selection's Move
 * action passes the selected root run (ADR 0018), moved together as one atomic
 * batch. The candidate list excludes the union of every moved node's subtree.
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
  // (textMatchIndices keeps only the "text" key). See ADR 0001.
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
  const [targets, setTargets] = useState<string[] | null>(null);
  const [mode, setMode] = useState<MoveMode>("move");
  const [query, setQuery] = useState("");
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  useEffect(() => {
    setMoveDialogOpener((nodeIds, nextMode) => {
      setTargets(nodeIds);
      setMode(nextMode);
      setQuery("");
    });
    return () => {
      setMoveDialogOpener(null);
    };
  }, []);

  if (!mounted) return null;

  return (
    <MoveDialogInner
      nodeIds={targets}
      mode={mode}
      onOpenChange={(next) => {
        if (!next) {
          setTargets(null);
          setQuery("");
        }
      }}
      query={query}
      setQuery={setQuery}
    />
  );
}

function MoveDialogInner({
  nodeIds,
  mode,
  onOpenChange,
  query,
  setQuery,
}: {
  nodeIds: string[] | null;
  mode: MoveMode;
  onOpenChange: (next: boolean) => void;
  query: string;
  setQuery: (q: string) => void;
}) {
  const { index } = useTree();
  const navigate = useNavigate();
  const open = nodeIds !== null && nodeIds.length > 0;

  // Candidate destinations: every node except the ones being moved and their own
  // subtrees (you can't move a branch into itself -- `moveNode` guards this too,
  // but listing those rows would be a dead press). Built only while open.
  //
  // Manually memoized despite React Compiler: the compiler folds this into one
  // reactive scope keyed on `query` too, so without the memo the subtree walk,
  // candidate filter, and Fuse INDEX all rebuild on every keystroke (verified
  // in the compiled output). Keyed on [index, nodeIds] so typing only re-runs
  // `results` (the cheap search) below.
  const candidates = useMemo(() => {
    if (!nodeIds || nodeIds.length === 0) return [];
    const excluded = new Set<string>();
    for (const id of nodeIds) {
      // Move can't drop a branch into itself, so exclude the node's own subtree.
      // Mirror can't window content that contains the mirror, so exclude the
      // SOURCE's subtree (a mirror's source, not the mirror) -- listing either
      // would be a dead press the mutation guards anyway (ADR 0022). For a plain
      // node the two roots coincide.
      const rootId = mode === "mirror" ? trueSourceOf(index, id) : id;
      for (const sub of subtreeIds(index, rootId)) excluded.add(sub);
    }
    return Array.from(index.byId.values()).filter(
      (n) => !excluded.has(n.id) && n.text.trim() !== "",
    );
  }, [index, nodeIds, mode]);

  const fuse = useMemo(
    () => (open ? new Fuse(candidates, FUSE_OPTIONS) : null),
    [open, candidates],
  );

  const q = query.trim();

  // null => empty-query mode (show bookmarks, mirroring the quick-switcher).
  // Otherwise the Fuse hits over every candidate. Left un-memoized: it depends
  // on `q`, so re-running per keystroke is correct.
  const results: Hit[] | null =
    !q || !fuse
      ? null
      : fuse
          .search(q, { limit: RESULT_LIMIT })
          .map((r) => ({ node: r.item, matches: r.matches }));

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

  const destName = (targetId: string | null) =>
    targetId === null
      ? "Home"
      : index.byId.get(targetId)?.text.trim() || "Untitled";

  const goTo = (targetId: string | null) => {
    if (targetId === null) navigate({ to: "/" });
    else navigate({ to: "/$nodeId", params: { nodeId: targetId } });
  };

  // Mirror each selected source under the destination as ONE atomic batch
  // (mirrorManyNodes appends them in order, rebuilding the index per insert).
  // Stays put with a toast (a "Go" jumps to where the mirrors landed); no flash
  // -- the source didn't move, and the new mirrors have fresh ids we don't hold.
  function mirror(targetId: string | null) {
    if (!nodeIds || nodeIds.length === 0) return;
    const ids = nodeIds;
    onOpenChange(false);
    const made = runStructural(() => {
      capture(index, ids[0]!);
      return mirrorManyNodes(targetId, ids);
    });
    // Nothing created => every source would have cycled (or vanished); the
    // captured undo point is dead, so discard it.
    if (!made) {
      drop();
      toast.error("Can't mirror there.");
      return;
    }
    const count = ids.length === 1 ? "" : `${made} nodes `;
    toast.success(`Mirrored ${count}to ${destName(targetId)}`, {
      action: { label: "Go", onClick: () => goTo(targetId) },
    });
  }

  function move(targetId: string | null) {
    if (!nodeIds || nodeIds.length === 0) return;
    const ids = nodeIds;
    onOpenChange(false);
    // Append the whole run as the destination's last children (or last top-level
    // for Home), in ONE atomic batch (moveManyNodes keeps their relative order
    // and rebuilds the index per move so the sibling chain stays intact).
    const moved = runStructural(() => {
      capture(index, ids[0]!);
      return moveManyNodes(targetId, ids);
    });
    // A no-op move (already at the exact destination) still captured an undo
    // point; discard it so Cmd+Z doesn't look dead and redo history survives.
    if (!moved) {
      drop();
      return;
    }
    // Stay put -- moving shouldn't navigate you away. Confirm with a toast, and
    // offer a "Go" action to jump to the destination's zoom view on demand
    // (plain nav, no morph, since no pivot dot is involved).
    const count = ids.length === 1 ? "" : `${moved} nodes `;
    toast.success(`Moved ${count}to ${destName(targetId)}`, {
      action: {
        label: "Go",
        onClick: () => {
          // Flash + focus the first moved node once the destination view mounts,
          // so it's easy to spot where the run landed. See flash-node.ts.
          requestFlashAfterNav(ids[0]!);
          goTo(targetId);
        },
      },
    });
  }

  // The picker UI is identical; only the completion differs by mode.
  const commit = mode === "mirror" ? mirror : move;
  const copy =
    mode === "mirror"
      ? {
          title: "Mirror node",
          description: "Choose where to show a live copy of this node",
          placeholder: "Mirror under...",
          heading: "Mirror under",
        }
      : {
          title: "Move node",
          description: "Choose a destination to move this node under",
          placeholder: "Move under...",
          heading: "Move under",
        };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={copy.description}
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={copy.placeholder}
        />
        <CommandList>
          {showHome && (
            <CommandGroup heading="Top level">
              <CommandItem value="__home__" onSelect={() => commit(null)}>
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
                    onSelect={commit}
                  />
                ))}
              </CommandGroup>
            )
          ) : results.length === 0 ? (
            !showHome && <Hint>No matches.</Hint>
          ) : (
            <CommandGroup heading={copy.heading}>
              {results.map(({ node, matches }) => (
                <DestinationRow
                  key={node.id}
                  index={index}
                  node={node}
                  matches={matches}
                  onSelect={commit}
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
