import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import { Search, BookmarkIcon } from "lucide-react";
import { useTree } from "../data/useTree";
import { buildTrail, type Node, type TreeIndex } from "../data/tree";
import { stripLinks } from "../data/links";
import {
  searchAliases,
  searchActions,
  searchAnnotation,
} from "../plugins/registry";
import type { SearchAction } from "../plugins/types";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

/**
 * Node quick-switcher (ADR 0012): a Cmd+K fuzzy jump-to over every node's text.
 *
 * It is a *jump-to*, not a command palette -- v1 runs no actions, only
 * navigation to a node's zoom view (`/$nodeId`). Self-contained, mirroring
 * `bookmarks.tsx`: it reads the tree (for the node list + breadcrumb context)
 * and owns its own open/query state and global hotkey. Mounted once in
 * `__root.tsx`; the header magnifier reaches it via {@link openNodeSwitcher}.
 */

// Module-level opener so the far-away header button (and any future caller) can
// open the single mounted dialog without a context provider -- same spirit as
// the module-level history stack. The mounted NodeSwitcher registers its setter.
let opener: (() => void) | null = null;

/** Open the quick-switcher from anywhere (e.g. the header search button). */
export function openNodeSwitcher() {
  opener?.();
}

// We search a link-stripped projection of each node (a `[label](url)` flattens
// to `label`), so URL noise stays out of the corpus and match indices line up
// with the clean text the result row displays. See ADR 0017.
interface Searchable {
  node: Node;
  text: string;
  // Extra match terms a plugin contributes for this node (Seam J) -- the daily
  // plugin's relative label ("Today"), absent from the full-date text. Searched
  // but NOT highlighted (highlight only looks at the "text" key), so the row
  // still displays node.text with no misaligned ranges. See ADR 0022.
  aliases: string[];
}

const FUSE_OPTIONS: IFuseOptions<Searchable> = {
  keys: ["text", "aliases"],
  includeMatches: true,
  // CRITICAL: without this Fuse penalizes matches late in the string, so
  // "notes" would miss "Weekly team notes". See ADR 0012.
  ignoreLocation: true,
  threshold: 0.3,
  minMatchCharLength: 2,
};

const RESULT_LIMIT = 50;

/**
 * Outer shell: owns open/query state and the global hotkey, but reads NO data.
 * The data-driven dialog ({@link SwitcherDialog}, which calls `useTree`) is
 * mounted **client-only** -- this component lives in `__root.tsx`, outside the
 * route error boundary that lets the editor degrade to client rendering, so its
 * `useLiveQuery` would otherwise hard-fail the `/` prerender (SPA mode, ADR 0004).
 */
export function NodeSwitcher() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Register the module-level opener for the lifetime of this mount.
  useEffect(() => {
    opener = () => setOpen(true);
    return () => {
      opener = null;
    };
  }, []);

  // Global Cmd+K / Ctrl+K. Capture phase so it fires even while the caret is
  // inside a contentEditable bullet -- preventDefault before the editor's own
  // keydown handlers see it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!mounted) return null;

  return (
    <SwitcherDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      query={query}
      setQuery={setQuery}
      onPicked={() => {
        setOpen(false);
        setQuery("");
      }}
    />
  );
}

function SwitcherDialog({
  open,
  onOpenChange,
  query,
  setQuery,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  query: string;
  setQuery: (q: string) => void;
  onPicked: () => void;
}) {
  const { index } = useTree();
  const navigate = useNavigate();

  const nodes = useMemo(() => Array.from(index.byId.values()), [index]);

  // Build the Fuse index only while open. When closed we skip the work; when
  // open the outline isn't being edited, so `nodes` is stable.
  const fuse = useMemo(() => {
    if (!open) return null;
    const searchable: Searchable[] = [];
    for (const n of nodes) {
      if (n.text.trim() !== "") {
        searchable.push({ node: n, text: stripLinks(n.text), aliases: searchAliases(n) });
      }
    }
    return new Fuse(searchable, FUSE_OPTIONS);
  }, [open, nodes]);

  const q = query.trim();

  // null => empty-query mode (show bookmarks). Otherwise the Fuse hits.
  const results = useMemo(() => {
    if (!q || !fuse) return null;
    return fuse.search(q, { limit: RESULT_LIMIT });
  }, [q, fuse]);

  const bookmarks = useMemo(
    () =>
      nodes
        .filter((n) => n.bookmarkedAt != null)
        .sort((a, b) => (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)),
    [nodes],
  );

  function go(nodeId: string) {
    onPicked();
    // Plain nav -- no zoom morph (ADR 0003): a result row isn't the pivot dot.
    navigate({ to: "/$nodeId", params: { nodeId } });
  }

  // Plugin-contributed VIRTUAL rows (Seam J), built from the live query -- the
  // daily plugin's "Go to Today" when today's note doesn't exist yet. Each runs
  // its own action (create + navigate) on pick. Empty for an empty query.
  const actions = useMemo<SearchAction[]>(() => {
    if (!q) return [];
    return searchActions(q, {
      index,
      goTo: (id) => {
        onPicked();
        navigate({ to: "/$nodeId", params: { nodeId: id } });
      },
    });
  }, [q, index, navigate, onPicked]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search nodes"
      description="Fuzzy-search and jump to any node"
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search nodes..."
        />
        <CommandList>
          {actions.length > 0 && (
            <CommandGroup heading="Actions">
              {actions.map((a) => (
                <ActionRow key={a.key} action={a} />
              ))}
            </CommandGroup>
          )}
          {results === null ? (
            bookmarks.length === 0 ? (
              <Hint>No bookmarks yet. Type to search your nodes.</Hint>
            ) : (
              <CommandGroup
                heading={
                  <div className="flex items-center gap-1">
                    <BookmarkIcon className="size-4" />
                    Bookmarks
                  </div>
                }
              >
                {bookmarks.map((node) => (
                  <ResultRow
                    key={node.id}
                    index={index}
                    node={node}
                    onSelect={go}
                  />
                ))}
              </CommandGroup>
            )
          ) : results.length === 0 ? (
            // Suppress "No matches" when a virtual action still answers the query
            // (e.g. "today" with no node, but the create-today action is shown).
            actions.length === 0 ? (
              <Hint>No matches.</Hint>
            ) : null
          ) : (
            <CommandGroup heading="Results">
              {results.map(({ item, matches }) => (
                <ResultRow
                  key={item.node.id}
                  index={index}
                  node={item.node}
                  matches={matches}
                  onSelect={go}
                />
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** The header magnifier -- the touch (and desktop) entry point. */
export function NodeSearchButton() {
  return (
    <Button variant="ghost" size="icon-sm" onClick={() => openNodeSwitcher()}>
      <Search />
      <span className="sr-only">Search nodes</span>
    </Button>
  );
}

/** A virtual (non-node) row -- a plugin's Seam-J action (e.g. "Go to Today").
 *  Carries its own icon and runs its own action on pick. */
function ActionRow({ action }: { action: SearchAction }) {
  const Icon = action.icon;
  return (
    <CommandItem value={action.key} onSelect={() => action.run()}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate">{action.label}</span>
        {action.hint && (
          <span className="truncate text-xs text-muted-foreground">
            {action.hint}
          </span>
        )}
      </div>
    </CommandItem>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function ResultRow({
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
  // breadcrumb ("Work › Q3 › Notes"). Displayed, never searched (ADR 0012).
  // Links flatten to their label so a crumb never shows raw `[..](..)`.
  const crumbs = buildTrail(index, node.id)
    .slice(0, -1)
    .map((n) => stripLinks(n.text).trim() || "Untitled")
    .join(" › ");

  const title = stripLinks(node.text).trim() || "Untitled";
  // A plugin's display-only suffix (Seam J) -- the daily plugin's "Today" -- so a
  // day note reads "Tuesday, June 23, 2026 (Today)". Not part of node.text, so
  // it's rendered as a separate, un-highlighted span after the title.
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
 * sorted; everything outside them renders plain.
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
