import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import { Search, BookmarkIcon, ChevronRightIcon } from "lucide-react";
import { useTree } from "../data/useTree";
import { buildTrail, type Node, type TreeIndex } from "../data/tree";
import { flattenNodeText } from "../data/node-links";
import { isMirrorsEnabled } from "../data/flags";
import {
  searchAliases,
  searchActions,
  searchAnnotation,
} from "../plugins/registry";
import type { SearchAction } from "../plugins/types";
import {
  buildNodeActions,
  resolveAmbientTargetId,
  type CommandCenterAction,
} from "../data/command-center";
import { getNodeActionBridge } from "../data/command-bridge";
import { cn } from "@/lib/utils";
import { setNodeSwitcherOpener, openNodeSwitcher } from "./node-switcher-opener";
import { useGlobalActions } from "./command-actions";
import { McpConnectDialog } from "./mcp-connect-dialog";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

/**
 * Cmd+K command center (ADR 0034): a keyboard-first door to BOTH nodes and
 * actions. It is the old node quick-switcher (a fuzzy jump-to over every node)
 * grown a command palette -- global/system actions (the header + More menu) plus
 * node-contextual actions (indent/complete/delete/move + plugin `/` commands)
 * run against an AMBIENT target (the bullet you came from, captured at open) or
 * any node you pick with `->`.
 *
 * Bridge, not spine: the actions come from thin adapters over the existing
 * models (`command-center.ts` for node actions read through `command-bridge`,
 * `command-actions.tsx` for globals) -- nothing here unifies those models.
 *
 * Self-contained and mounted once in `__root.tsx`; the header magnifier reaches
 * it via {@link openNodeSwitcher}.
 */

interface Searchable {
  node: Node;
  text: string;
  aliases: string[];
}

const FUSE_OPTIONS: IFuseOptions<Searchable> = {
  keys: ["text", "aliases"],
  includeMatches: true,
  ignoreLocation: true,
  threshold: 0.3,
  minMatchCharLength: 2,
};

const RESULT_LIMIT = 50;
const ACTIONS_CAP = 6;

const BOOKMARKS_HEADING = (
  <div className="flex items-center gap-1">
    <BookmarkIcon className="size-4" />
    Bookmarks
  </div>
);

function buildFuse(index: TreeIndex, nodes: Node[]): Fuse<Searchable> {
  const mirrorsOn = isMirrorsEnabled();
  const searchable: Searchable[] = [];
  for (const n of nodes) {
    if (n.text.trim() === "") continue;
    if (mirrorsOn && n.mirrorOf != null) continue;
    searchable.push({
      node: n,
      text: flattenNodeText(index, n.text),
      aliases: searchAliases(n),
    });
  }
  return new Fuse(searchable, FUSE_OPTIONS);
}

/** Lightweight action match: every whitespace-token of the query must appear in
 *  the row's label or keywords. Fuse drives the (larger) node corpus; the action
 *  set is tiny, so a substring/token match is enough and dependency-free. */
function matchAction(q: string, action: CommandCenterAction): boolean {
  const hay = `${action.label} ${(action.keywords ?? []).join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}

/** The focused bullet's node id, read from the DOM. Called in the capture-phase
 *  keydown BEFORE the dialog steals focus -- the only moment `activeElement` is
 *  still the bullet (ADR 0034). The `<li data-node-id>` carries the real node id
 *  (unlike the focus registry's row key, which is a path address inside a
 *  mirror), so this targets the underlying node directly. */
function readFocusedNodeId(): string | null {
  const active = document.activeElement as HTMLElement | null;
  return active?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null;
}

export function NodeSwitcher() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The ambient target snapshot -- captured at open, frozen for the overlay's
  // lifetime (never re-read while open: `activeElement` is the search input by
  // then). See ADR 0034 / issue #83.
  const [targetFocusedId, setTargetFocusedId] = useState<string | null>(null);
  // The MCP connect dialog is a shell sibling (not inside the CommandDialog) so
  // it survives the switcher closing on select -- mirrors header-more-menu.tsx.
  const [connectOpen, setConnectOpen] = useState(false);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // A ref mirrors `open` so the (mount-once) keydown listener can read the live
  // value without a stale closure -- and so open+capture commit as SIBLING state
  // updates in one batched render. (Setting `targetFocusedId` INSIDE a `setOpen`
  // updater splits it across two renders; the dialog then mounts on the first,
  // target-less, render and the React Compiler freezes that empty list.)
  const openRef = useRef(open);
  openRef.current = open;

  // Capture the ambient target, THEN open -- both before the dialog steals focus.
  const openWithCapture = useCallback(() => {
    setTargetFocusedId(readFocusedNodeId());
    setOpen(true);
  }, []);

  const onOpenConnect = useCallback(() => setConnectOpen(true), []);

  useEffect(() => {
    setNodeSwitcherOpener(openWithCapture);
    return () => {
      setNodeSwitcherOpener(null);
    };
  }, [openWithCapture]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (openRef.current) {
          setOpen(false);
        } else {
          setTargetFocusedId(readFocusedNodeId());
          setOpen(true);
        }
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!mounted) return null;

  return (
    <>
      <SwitcherDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        query={query}
        setQuery={setQuery}
        targetFocusedId={targetFocusedId}
        onOpenConnect={onOpenConnect}
        onPicked={() => {
          setOpen(false);
          setQuery("");
        }}
      />
      <McpConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}

function SwitcherDialog({
  open,
  onOpenChange,
  query,
  setQuery,
  targetFocusedId,
  onOpenConnect,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  query: string;
  setQuery: (q: string) => void;
  targetFocusedId: string | null;
  onOpenConnect: () => void;
  onPicked: () => void;
}) {
  // The React Compiler otherwise memoizes the cmdk list children and freezes the
  // first (target-less) render's list, so ambient/command groups added on a
  // later render never appear -- the same freeze that forces OutlineEditor's
  // opt-out (ADR 0019). The list is rebuilt from cheap state each render anyway.
  "use no memo";
  const { index } = useTree();
  const navigate = useNavigate();
  const bridge = getNodeActionBridge();

  const nodes = useMemo(() => Array.from(index.byId.values()), [index]);

  const fuse = useMemo(
    () => (open ? buildFuse(index, nodes) : null),
    [open, index, nodes],
  );

  const q = query.trim();
  const results = !q || !fuse ? null : fuse.search(q, { limit: RESULT_LIMIT });

  const bookmarks = useMemo(
    () =>
      nodes
        .filter((n) => n.bookmarkedAt != null)
        .sort((a, b) => (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)),
    [nodes],
  );

  // The ambient target: the focused bullet, else the zoom root when zoomed. Only
  // recomputed when the overlay (re)opens or its captured focus changes.
  const ambientTargetId = useMemo(
    () => (open ? resolveAmbientTargetId(targetFocusedId) : null),
    [open, targetFocusedId],
  );
  const ambientActions = useMemo(
    () => (ambientTargetId ? buildNodeActions(ambientTargetId, index, bridge) : []),
    [ambientTargetId, index, bridge],
  );
  const ambientLabel = ambientTargetId
    ? flattenNodeText(index, index.byId.get(ambientTargetId)?.text ?? "").trim() ||
      "Untitled"
    : "";

  const globalActions = useGlobalActions({ openConnect: onOpenConnect });

  // Per-result "actions for this node" sub-view (ADR 0034 / #83's `->` path).
  const [actionNodeId, setActionNodeId] = useState<string | null>(null);
  const subActions = useMemo(
    () => (actionNodeId ? buildNodeActions(actionNodeId, index, bridge) : []),
    [actionNodeId, index, bridge],
  );
  const subLabel = actionNodeId
    ? flattenNodeText(index, index.byId.get(actionNodeId)?.text ?? "").trim() ||
      "Untitled"
    : "";

  function reset() {
    setActionNodeId(null);
  }

  function close() {
    reset();
    onPicked();
  }

  // Enter the per-result actions sub-view. Clear the query -- the node-search
  // text is meaningless as an action filter, and a clean box lets you filter the
  // node's actions.
  function openActions(nodeId: string) {
    setQuery("");
    setActionNodeId(nodeId);
  }

  function backToList() {
    setQuery("");
    setActionNodeId(null);
  }

  function go(nodeId: string) {
    close();
    navigate({ to: "/$nodeId", params: { nodeId } });
  }

  function runAction(action: CommandCenterAction) {
    close();
    action.run();
  }

  const actions: SearchAction[] = q
    ? searchActions(q, {
        index,
        goTo: (id, opts) => {
          close();
          navigate({
            to: "/$nodeId",
            params: { nodeId: id },
            search: opts?.focus ? { focus: opts.focus } : {},
          });
        },
      })
    : [];

  const shownAmbient = q
    ? ambientActions.filter((a) => matchAction(q, a))
    : ambientActions;
  // On an empty query, show every global action so the palette is BROWSABLE
  // (read what exists, try it). On a query, match + cap so nodes aren't buried.
  const shownGlobals = q
    ? globalActions.filter((a) => matchAction(q, a)).slice(0, ACTIONS_CAP)
    : globalActions;
  const shownSub = q ? subActions.filter((a) => matchAction(q, a)) : subActions;

  function onKeyDown(e: React.KeyboardEvent) {
    // Sub-view: Left (or Backspace on an empty box) steps back to the list.
    // Escape is left to Radix -- it closes the whole palette from any level.
    if (actionNodeId) {
      if (e.key === "ArrowLeft" || (e.key === "Backspace" && q === "")) {
        e.preventDefault();
        backToList();
      }
      return;
    }
    // Main list: Right / Tab on a highlighted NODE result opens its actions.
    // Read the selected id straight off cmdk's active option in the DOM
    // (`data-selected`) -- robust to cmdk value quirks; only node ROWS carry a
    // `data-result-id`, so an action row's highlight never triggers this.
    if ((e.key === "ArrowRight" || e.key === "Tab") && !e.shiftKey) {
      const selected = document.querySelector<HTMLElement>(
        '[role="option"][data-selected="true"]',
      );
      const id = selected?.dataset.resultId;
      if (id) {
        e.preventDefault();
        openActions(id);
      }
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Command center"
      description="Search nodes and run actions"
    >
      {/* onKeyDown rides a display:contents wrapper (bubble phase), NOT the
          Command prop -- cmdk overrides its root onKeyDown, so a prop handler is
          dropped. The keys we intercept (Left/Right/Tab/Backspace) are ones cmdk
          ignores, so bubble-phase interception never fights its arrow nav. */}
      <div className="contents" onKeyDown={onKeyDown}>
      <Command shouldFilter={false}>
        {actionNodeId && (
          <button
            type="button"
            onClick={backToList}
            className="flex w-full items-center gap-1.5 border-b px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRightIcon className="size-3 rotate-180" />
            Actions on:{" "}
            <span className="truncate font-medium">{subLabel}</span>
          </button>
        )}
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={
            actionNodeId ? "Filter actions..." : "Search nodes and actions..."
          }
        />
        {actionNodeId ? (
          <CommandList>
            {shownSub.length === 0 ? (
              <Hint>No matching actions.</Hint>
            ) : (
              <CommandGroup heading="Actions">
                {shownSub.map((a) => (
                  <ActionCommandRow
                    key={a.id}
                    action={a}
                    onRun={() => runAction(a)}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        ) : (
          <>
            <CommandList>
              {shownAmbient.length > 0 && (
                <CommandGroup heading={`Acting on: ${ambientLabel}`}>
                  {shownAmbient.map((a) => (
                    <ActionCommandRow
                      key={a.id}
                      action={a}
                      onRun={() => runAction(a)}
                    />
                  ))}
                </CommandGroup>
              )}

              {(actions.length > 0 || shownGlobals.length > 0) && (
                <CommandGroup heading={q ? "Actions" : "Commands"}>
                  {actions.map((a) => (
                    <SearchActionRow key={a.key} action={a} />
                  ))}
                  {shownGlobals.map((a) => (
                    <ActionCommandRow
                      key={a.id}
                      action={a}
                      onRun={() => runAction(a)}
                    />
                  ))}
                </CommandGroup>
              )}

              {results === null ? (
                bookmarks.length === 0 ? (
                  <Hint>No bookmarks yet. Type to search nodes and actions.</Hint>
                ) : (
                  <CommandGroup heading={BOOKMARKS_HEADING}>
                    {bookmarks.map((node) => (
                      <ResultRow
                        key={node.id}
                        index={index}
                        node={node}
                        onSelect={go}
                        onOpenActions={setActionNodeId}
                      />
                    ))}
                  </CommandGroup>
                )
              ) : results.length === 0 ? (
                actions.length === 0 && shownGlobals.length === 0 ? (
                  <Hint>No matches.</Hint>
                ) : null
              ) : (
                <CommandGroup heading="Nodes">
                  {results.map(({ item, matches }) => (
                    <ResultRow
                      key={item.node.id}
                      index={index}
                      node={item.node}
                      matches={matches}
                      onSelect={go}
                      onOpenActions={setActionNodeId}
                    />
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </>
        )}
      </Command>
      </div>
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

/** A command-center action row (global or node scope) with a right-aligned
 *  hotkey hint. `value` is the action id so it never collides with node ids. */
function ActionCommandRow({
  action,
  onRun,
}: {
  action: CommandCenterAction;
  onRun: () => void;
}) {
  const Icon = action.icon;
  return (
    <CommandItem value={action.id} onSelect={onRun}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate">{action.label}</span>
        <span className="truncate text-xs text-muted-foreground">
          {action.description}
        </span>
      </div>
      {action.hotkey && action.hotkey.length > 0 && (
        // data-slot="command-shortcut" hides CommandItem's trailing check so the
        // shortcut sits flush at the row's right edge (ml-auto).
        <span data-slot="command-shortcut" className="ml-auto shrink-0">
          <KbdGroup>
            {action.hotkey.map((k, i) => (
              <Kbd key={i}>{k}</Kbd>
            ))}
          </KbdGroup>
        </span>
      )}
    </CommandItem>
  );
}

/** A plugin Seam-J virtual row (e.g. daily's "Go to Today"). */
function SearchActionRow({ action }: { action: SearchAction }) {
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
  onOpenActions,
}: {
  index: TreeIndex;
  node: Node;
  matches?: readonly FuseResultMatch[];
  onSelect: (nodeId: string) => void;
  onOpenActions: (nodeId: string) => void;
}) {
  const crumbs = buildTrail(index, node.id)
    .slice(0, -1)
    .map((n) => flattenNodeText(index, n.text).trim() || "Untitled")
    .join(" › ");

  const title = flattenNodeText(index, node.text).trim() || "Untitled";
  const annotation = searchAnnotation(node);

  return (
    <CommandItem
      value={node.id}
      data-result-id={node.id}
      onSelect={() => onSelect(node.id)}
      className="group"
    >
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
      {/* Enter jumps to the node; -> (or this affordance) opens its actions. */}
      <button
        type="button"
        aria-label="Node actions"
        title="Actions (→)"
        className="ml-auto hidden shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted group-data-[selected=true]:flex"
        onClick={(e) => {
          e.stopPropagation();
          onOpenActions(node.id);
        }}
      >
        Actions
        <ChevronRightIcon className="size-3" />
      </button>
    </CommandItem>
  );
}

function textMatchIndices(
  matches?: readonly FuseResultMatch[],
): readonly [number, number][] | undefined {
  return matches?.find((m) => m.key === "text")?.indices;
}

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
