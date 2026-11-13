import { ArrowLeft01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import { BookmarkIcon, ChevronRightIcon, FilterIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import type { PluginDef, SearchAction } from "../plugins/types";
import type { FindRequest } from "./node-switcher-opener";

import { getNodeActionBridge } from "../data/command-bridge";
import {
  buildNodeActions,
  resolveAmbientTargetId,
  type CommandCenterAction,
} from "../data/command-center";
import { localDateKey } from "../data/date-links";
import {
  buildFilterSuggestions,
  caretToken,
  hasQuerySyntax,
  nodeMatches,
  parseFilterQuery,
  walkQueryNodes,
} from "../data/filter-query";
import { isMirrorsEnabled } from "../data/flags";
import { flattenNodeText } from "../data/node-links";
import { useSavedQueries } from "../data/saved-queries";
import { matchSavedQuery } from "../data/saved-queries-core";
import { collectTagCorpus } from "../data/tags";
import {
  buildTrail,
  trueSourceOf,
  type Node,
  type TreeIndex,
} from "../data/tree";
import { useTree } from "../data/useTree";
import { useIsMobile } from "../hooks/use-mobile";
import {
  usePluginChrome,
  searchActions,
  searchAnnotation,
  filterOperatorMap,
  filterOperatorInfos,
} from "../plugins/registry";
import { useGlobalActions } from "./command-actions";
import {
  decorate,
  getCaretOffset,
  readSource,
  setCaretOffset,
} from "./inline-code";
import { McpConnectDialog } from "./mcp-connect-dialog";
import { MenuSheetContent } from "./menu-sheet";
import {
  setNodeSwitcherOpener,
  openNodeSwitcher,
} from "./node-switcher-opener";
import { QueryFilterChips } from "./query-filter-chips";
import { openFilterInput, writeQuery } from "./query-filter-nav";
import { readFormatTarget } from "./selection-format";
import { Button } from "./ui/button";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

declare module "@tanstack/history" {
  interface HistoryState {
    findReturn?: {
      query: string;
      selection: string;
    };
  }
}

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

const SAVED_FILTERS_HEADING = (
  <div className="flex items-center gap-1">
    <FilterIcon className="size-4" />
    Saved filters
  </div>
);

function buildFuse(
  index: TreeIndex,
  nodes: Node[],
  aliasProviders: readonly NonNullable<PluginDef["searchAliases"]>[],
): Fuse<Searchable> {
  const mirrorsOn = isMirrorsEnabled();
  const searchable: Searchable[] = [];
  for (const n of nodes) {
    if (n.text.trim() === "") continue;
    if (mirrorsOn && n.mirrorOf != null) continue;
    searchable.push({
      node: n,
      text: flattenNodeText(index, n.text),
      aliases: aliasProviders.flatMap((provider) => provider(n)),
    });
  }
  return new Fuse(searchable, FUSE_OPTIONS);
}

/** Lightweight action match: every whitespace-token of the query must appear in
 *  the row's label or keywords. Fuse drives the (larger) node corpus; the action
 *  set is tiny, so a substring/token match is enough and dependency-free. */
function matchAction(q: string, action: CommandCenterAction): boolean {
  const hay =
    `${action.label} ${(action.keywords ?? []).join(" ")}`.toLowerCase();
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
  // SAFETY: document.activeElement is an Element or null, elements here are HTMLElements
  const active = document.activeElement as HTMLElement | null;
  return active?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null;
}

export function NodeSwitcher() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState("");
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
  const restoreEditor = useRef<(() => void) | null>(null);

  // Capture the ambient target, THEN open -- both before the dialog steals focus.
  const openWithCapture = useCallback((request?: FindRequest) => {
    setQuery(request?.query ?? "");
    setSelection(request?.selection ?? "");
    setTargetFocusedId(readFocusedNodeId());
    const el = document.activeElement;
    restoreEditor.current = null;
    if (el instanceof HTMLElement && el.matches(".node-text")) {
      const offset = getCaretOffset(el);
      restoreEditor.current = () => {
        if (!el.isConnected) return;
        el.focus({ preventScroll: true });
        // Blur folds tokens and replaces their DOM. Restore a source offset,
        // revealing its token before placing the caret, never a stale Range.
        decorate(el, readSource(el), offset, false);
        setCaretOffset(el, offset);
      };
    }
    setOpen(true);
    if (request?.selection) {
      // cmdk selects the first row after initializing its input search. Restore
      // the saved row only after that mount-time selection has committed.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (openRef.current) setSelection(request.selection!);
        }),
      );
    }
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
        // A text selection belongs to the editor's link keymap. Let it run
        // before a command dialog can steal the selection and focus.
        const active = document.activeElement;
        if (
          !openRef.current &&
          !e.shiftKey &&
          !e.altKey &&
          active?.matches(".node-text") &&
          !active.closest("[data-typing-menu-open]") &&
          readFormatTarget()
        )
          return;
        e.preventDefault();
        if (openRef.current) {
          setOpen(false);
        } else {
          openWithCapture();
        }
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [openWithCapture]);

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
        selection={selection}
        setSelection={setSelection}
        targetFocusedId={targetFocusedId}
        restoreEditor={() => restoreEditor.current?.()}
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
  selection,
  setSelection,
  targetFocusedId,
  restoreEditor,
  onOpenConnect,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  query: string;
  setQuery: (q: string) => void;
  selection: string;
  setSelection: (selection: string) => void;
  targetFocusedId: string | null;
  restoreEditor: () => void;
  onOpenConnect: () => void;
  onPicked: () => void;
}) {
  // The React Compiler otherwise memoizes the cmdk list children and freezes the
  // first (target-less) render's list, so ambient/command groups added on a
  // later render never appear -- the same freeze that forces OutlineEditor's
  // opt-out (ADR 0019). The list is rebuilt from cheap state each render anyway.
  "use no memo";
  const { index } = useTree();
  const { aliasProviders } = usePluginChrome();
  const navigate = useNavigate();
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const mobile = useIsMobile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [actionNodeId, setActionNodeId] = useState<string | null>(null);
  const bridge = getNodeActionBridge();
  const afterClose = useRef<(() => void) | null>(null);

  // Full-index work stays behind the open palette, never the editor's hot path.
  const nodes = useMemo(
    () =>
      open
        ? Array.from(
            walkQueryNodes(index, null, {
              deduplicate: true,
              mirrorsEnabled: isMirrorsEnabled(),
            }),
            ({ node }) => node,
          )
        : [],
    [open, index],
  );
  const nearby = useMemo(
    () =>
      new Set(
        open && rootId !== null
          ? Array.from(
              walkQueryNodes(index, rootId, {
                includeRoot: true,
                deduplicate: true,
                mirrorsEnabled: isMirrorsEnabled(),
              }),
              ({ node }) => [node.id, trueSourceOf(index, node.id)],
            ).flat()
          : [],
      ),
    [open, index, rootId],
  );

  const fuse = useMemo(
    () => (open ? buildFuse(index, nodes, aliasProviders) : null),
    [open, index, nodes, aliasProviders],
  );

  const q = query.trim();
  const exact = hasQuerySyntax(q);
  const today = localDateKey();
  const results = useMemo(() => {
    if (!q || !fuse) return null;
    const parsed = parseFilterQuery(q);
    if (exact && parsed.groups.length === 0) return [];
    const matched = exact
      ? nodes
          .filter(
            (node) =>
              node.mirrorOf === null &&
              nodeMatches(parsed, node, index, filterOperatorMap, today),
          )
          .map((node) => ({
            item: { node },
            matches: undefined,
          }))
      : fuse.search(q);
    // Stable partition preserves fuzzy rank (or DQL outline order) within each group.
    return [
      ...matched.filter(({ item }) => nearby.has(item.node.id)),
      ...matched.filter(({ item }) => !nearby.has(item.node.id)),
    ];
  }, [q, exact, fuse, nodes, index, nearby, today]);
  const token = caretToken(query, caret);
  const suggestions =
    open && !actionNodeId && /^-?(?:#|highlight:)/.test(token.token)
      ? buildFilterSuggestions(
          token.token,
          filterOperatorInfos,
          collectTagCorpus(index.tagCorpus),
        )
      : [];

  function changeQuery(next: string) {
    setQuery(next);
    setSelection("");
    setCaret(next.length);
  }
  function insertQuery(next: string) {
    changeQuery(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  }

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
  const ambientActions = ambientTargetId
    ? buildNodeActions(ambientTargetId, index, bridge)
    : [];
  const ambientLabel = ambientTargetId
    ? flattenNodeText(
        index,
        index.byId.get(ambientTargetId)?.text ?? "",
      ).trim() || "Untitled"
    : "";

  const globalActions = useGlobalActions({ openConnect: onOpenConnect });

  // Saved queries stay in Find when selected; filtering is a separate handoff
  // through Filter in place or Shift+Enter (ADR 0081).
  const savedQueries = useSavedQueries();

  // Per-result "actions for this node" sub-view (ADR 0034 / #83's `->` path).
  const subActions = actionNodeId
    ? buildNodeActions(actionNodeId, index, bridge)
    : [];
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

  function afterPaletteClose() {
    const run = afterClose.current;
    afterClose.current = null;
    if (!run) return true;
    run();
    return false;
  }

  function go(nodeId: string) {
    const findReturn = { query, selection: nodeId };
    if (mobile) {
      afterClose.current = () => {
        void navigate({
          to: "/$nodeId",
          params: { nodeId },
          search: {},
          state: { findReturn },
        });
      };
      close();
    } else {
      close();
      void navigate({
        to: "/$nodeId",
        params: { nodeId },
        search: {},
        state: { findReturn },
      });
    }
  }

  function filterInPlace(home = false) {
    const text = query;
    afterClose.current = () => {
      if (home) {
        void navigate({
          to: "/",
          search: text.trim() ? { q: text.trim() } : {},
        });
      } else {
        void Promise.resolve(writeQuery(text)).then(() => openFilterInput());
      }
    };
    close();
  }

  function runAction(action: CommandCenterAction) {
    if (action.disabled) return;
    if (mobile || action.executionPhase === "after-editor-restore") {
      // Native sheets must release modality before another overlay opens.
      // Spotlight also needs its original editor focus restored first.
      afterClose.current = () => {
        if (action.executionPhase === "after-editor-restore") restoreEditor();
        action.run();
      };
      close();
      return;
    }
    // Run BEFORE close: verbs like Delete prefer `findFocusedId() ?? id`, and
    // closing the dialog first can restore focus onto an unrelated row,
    // deleting the wrong node.
    action.run();
    close();
  }

  const actions: SearchAction[] =
    q && !exact
      ? searchActions(q, {
          index,
          goTo: (id, opts) => {
            const goTo = () => {
              void navigate({
                to: "/$nodeId",
                params: { nodeId: id },
                search: opts?.focus ? { focus: opts.focus } : {},
              });
            };
            if (mobile) afterClose.current = goTo;
            else goTo();
            close();
          },
        })
      : [];

  const shownAmbient = exact
    ? []
    : q
      ? ambientActions.filter((a) => matchAction(q, a))
      : ambientActions;
  // On an empty query, show every global action so the palette is BROWSABLE
  // (read what exists, try it). On a query, match + cap so nodes aren't buried.
  const shownGlobals = exact
    ? []
    : q
      ? globalActions.filter((a) => matchAction(q, a)).slice(0, ACTIONS_CAP)
      : globalActions;
  const shownSub = q ? subActions.filter((a) => matchAction(q, a)) : subActions;
  // Empty query: all saved filters (newest-first from the hook). A query: matches.
  const shownSaved = q
    ? savedQueries.filter((r) => matchSavedQuery(q, r))
    : savedQueries;

  function runSavedFilter(query: string) {
    insertQuery(query);
  }

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

  const content = (
    <div
      className="contents"
      onKeyDown={onKeyDown}
      onKeyDownCapture={(event) => {
        if (
          !actionNodeId &&
          ((event.key === "Enter" && event.shiftKey) ||
            ((event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "f"))
        ) {
          event.preventDefault();
          event.stopPropagation();
          filterInPlace();
        }
      }}
    >
      <Command
        className="[@media(pointer:coarse)]:[&_[cmdk-item]]:min-h-11"
        shouldFilter={false}
        label={actionNodeId ? "Filter actions" : "Find nodes and actions"}
        value={selection}
        onValueChange={setSelection}
      >
        {actionNodeId && (
          <button
            type="button"
            onClick={backToList}
            className="flex w-full items-center gap-1.5 border-b px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRightIcon className="size-3 rotate-180" />
            Actions on: <span className="truncate font-medium">{subLabel}</span>
          </button>
        )}
        <CommandInput
          ref={inputRef}
          data-sheet-autofocus=""
          value={query}
          onValueChange={changeQuery}
          onSelect={(event) =>
            setCaret(event.currentTarget.selectionStart ?? query.length)
          }
          placeholder={
            actionNodeId ? "Filter actions..." : "Search nodes and actions..."
          }
          aria-label={
            actionNodeId ? "Filter actions" : "Find nodes and actions"
          }
        />
        {!actionNodeId && (
          <>
            <div className="flex items-center justify-between gap-2 px-2 pt-2 text-xs text-muted-foreground">
              <span>Everywhere</span>
              <Button size="xs" variant="ghost" onClick={() => filterInPlace()}>
                Filter in place{" "}
                <span className="hidden sm:inline">⇧ Enter</span>
              </Button>
            </div>
            <QueryFilterChips query={query} onChange={insertQuery} />
          </>
        )}
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
              {suggestions.length > 0 && (
                <CommandGroup heading="Suggestions">
                  {suggestions.map((suggestion) => (
                    <CommandItem
                      key={suggestion.id}
                      value={`suggest:${suggestion.id}`}
                      onSelect={() =>
                        insertQuery(
                          query.slice(0, token.start) +
                            suggestion.insert +
                            query.slice(token.end),
                        )
                      }
                    >
                      {suggestion.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
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

              {shownSaved.length > 0 && (
                <CommandGroup heading={SAVED_FILTERS_HEADING}>
                  {shownSaved.map((r) => (
                    <SavedFilterRow
                      key={r.id}
                      row={r}
                      onRun={() => runSavedFilter(r.query)}
                    />
                  ))}
                </CommandGroup>
              )}

              {results === null ? (
                bookmarks.length === 0 ? (
                  shownSaved.length === 0 ? (
                    <Hint>
                      No bookmarks yet. Type to search nodes and actions.
                    </Hint>
                  ) : null
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
                actions.length === 0 &&
                shownGlobals.length === 0 &&
                shownSaved.length === 0 ? (
                  <Hint>No matches.</Hint>
                ) : null
              ) : (
                <CommandGroup heading="Nodes">
                  {results.slice(0, RESULT_LIMIT).map(({ item, matches }) => (
                    <ResultRow
                      key={item.node.id}
                      index={index}
                      node={item.node}
                      matches={matches}
                      nearby={nearby.has(item.node.id)}
                      onSelect={go}
                      onOpenActions={openActions}
                    />
                  ))}
                </CommandGroup>
              )}
              {results && exact && results.length > RESULT_LIMIT && (
                <CommandGroup
                  heading={`Showing 50 of ${results.length} matches`}
                >
                  <CommandItem
                    value="filter-home"
                    onSelect={() => filterInPlace(true)}
                  >
                    <FilterIcon className="size-4" />
                    <span className="truncate">Filter Home for {q}</span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </>
        )}
      </Command>
    </div>
  );
  const changeOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  return mobile ? (
    <MenuSheetContent
      title="Find"
      detents={["large"]}
      isOpen={open}
      onOpenChange={changeOpen}
      onAfterClose={afterPaletteClose}
    >
      {content}
    </MenuSheetContent>
  ) : (
    <CommandDialog
      open={open}
      onOpenChange={changeOpen}
      title="Find"
      animateResize
      description="Find nodes everywhere or run actions. Filter in place to stay here."
      finalFocus={afterPaletteClose}
    >
      {content}
    </CommandDialog>
  );
}

/** One Find door: the desktop magnifier and Cmd+K open the same palette. */
export function FindButton() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => openNodeSwitcher()}
            aria-label="Search"
          />
        }
      >
        <HugeiconsIcon icon={Search01Icon} />
      </TooltipTrigger>
      <TooltipContent>
        Find everywhere <Kbd>⌘K</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** Return context belongs to the destination's history entry, not a global query. */
export function BackToFind() {
  const previous = useLocation({
    select: (location) => location.state.findReturn,
  });
  const router = useRouter();
  if (!previous) return null;
  return (
    <div className="mx-auto w-full max-w-180 px-6 pt-3 max-sm:px-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          router.history.back();
          openNodeSwitcher(previous);
        }}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} />
        Back to search
      </Button>
    </div>
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
    <CommandItem value={action.id} onSelect={onRun} disabled={action.disabled}>
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

/** A saved-filter row (ADR 0048): runs the query on select. `value` is prefixed
 *  so it never collides with a node id or action id in cmdk. */
function SavedFilterRow({
  row,
  onRun,
}: {
  row: { id: string; name: string; query: string };
  onRun: () => void;
}) {
  const showQuery = row.name.trim() !== row.query.trim();
  return (
    <CommandItem value={`saved:${row.id}`} onSelect={onRun}>
      <FilterIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate">{row.name}</span>
        {showQuery && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {row.query}
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
  nearby,
  onSelect,
  onOpenActions,
}: {
  index: TreeIndex;
  node: Node;
  matches?: readonly FuseResultMatch[];
  nearby?: boolean;
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
          {nearby && (
            <span className="ml-2 text-xs text-muted-foreground">here</span>
          )}
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
        data-slot="command-shortcut"
        className="ml-auto hidden shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground group-data-[selected=true]:flex hover:bg-muted"
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
