import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import { HomeIcon } from "lucide-react";
import { useTree } from "../data/useTree";
import { buildTrail, childrenOf, type Node, type TreeIndex } from "../data/tree";
import { moveNode } from "../data/mutations";
import { capture } from "../data/history";
import { cn } from "@/lib/utils";
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
 * After the move it navigates to the destination's zoom view so the moved node
 * is visible in its new home (plain nav, no zoom morph -- there's no pivot dot).
 */

// Module-level opener so the slash command (deep inside a bullet's
// contentEditable) can open the single mounted dialog without a context
// provider -- same spirit as the quick-switcher's opener and the history stack.
let opener: ((nodeId: string) => void) | null = null;

/** Open the move picker for `nodeId` from anywhere (e.g. the `/move` command). */
export function openMoveDialog(nodeId: string) {
  opener?.(nodeId);
}

const FUSE_OPTIONS: IFuseOptions<Node> = {
  keys: ["text"],
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
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    opener = (nodeId) => {
      setTarget(nodeId);
      setQuery("");
    };
    return () => {
      opener = null;
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

  const results = useMemo<Hit[]>(() => {
    if (!q || !fuse) {
      return candidates.slice(0, RESULT_LIMIT).map((node) => ({ node }));
    }
    return fuse
      .search(q, { limit: RESULT_LIMIT })
      .map((r) => ({ node: r.item, matches: r.matches }));
  }, [q, fuse, candidates]);

  // "Home" shows on an empty query or when the text looks like the word.
  const showHome = q === "" || "home".includes(q.toLowerCase());

  function move(targetId: string | null) {
    if (!nodeId) return;
    onOpenChange(false);
    capture(index, nodeId);
    // Append as the last child of the destination (or last top-level for Home).
    const siblings = childrenOf(index, targetId);
    const after = siblings.length ? siblings[siblings.length - 1]!.id : null;
    const moved = moveNode(index, nodeId, targetId, after);
    if (!moved) return;
    // Land in the destination's zoom view so the moved node is visible in its
    // new home. Plain nav, no morph (ADR 0003): no pivot dot is involved.
    if (targetId === null) navigate({ to: "/" });
    else navigate({ to: "/$nodeId", params: { nodeId: targetId } });
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
          {results.length === 0 ? (
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
  ranges.forEach(([start, end], i) => {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <mark
        key={i}
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
