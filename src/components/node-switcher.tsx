import {
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  BookmarkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FilterIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
} from "@/lib/icons";
import { cn } from "@/lib/utils";

import type { PluginDef, SearchAction } from "../plugins/types";
import type { FindRequest, FindScope } from "./node-switcher-opener";

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
import {
  deleteSavedQuery,
  renameSavedQuery,
  useSavedQueries,
} from "../data/saved-queries";
import {
  matchSavedQuery,
  type SavedQueryRow,
} from "../data/saved-queries-core";
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
import { writeQuery } from "./query-filter-nav";
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
  const [scope, setScope] = useState<FindScope>("all");
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
    setScope(request?.scope ?? "all");
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
        scope={scope}
        setScope={setScope}
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
  scope: requestedScope,
  setScope,
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
  scope: FindScope;
  setScope: (scope: FindScope) => void;
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
  const tokenSuggestions =
    // Tags and every `key:` value, such as `is:todo` and `highlight:red`. A
    // bare word suggests nothing so commands and nodes stay on top.
    open && !actionNodeId && /^-?(?:#|[a-z][\w-]*:)/i.test(token.token)
      ? buildFilterSuggestions(
          token.token,
          filterOperatorInfos,
          collectTagCorpus(index.tagCorpus),
        )
      : [];
  // A finished term, such as a reopened filter's last token, keeps Enter for
  // the results instead of re-inserting itself.
  // A bare `key:` stays open so its values still list.
  const suggestions = tokenSuggestions.some(
    (s) => !token.token.endsWith(":") && s.insert.trim() === token.token,
  )
    ? []
    : tokenSuggestions;

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

  // Saved queries fill Find when selected; Show in outline or Shift+Enter
  // applies them to the current view (ADR 0083, 0089).
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
        // Focus the pill, the applied filter's handle, rather than a bullet
        // the new filter may hide; an emptied query leaves the outline caret.
        void Promise.resolve(writeQuery(text)).then(() =>
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>("[data-filter-pill]")
              ?.focus({ preventScroll: true }),
          ),
        );
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
  const matchingGlobals = exact
    ? []
    : q
      ? globalActions.filter((a) => matchAction(q, a))
      : globalActions;
  // The Commands scope lists every match; mixed results cap so nodes stay visible.
  const shownGlobals =
    q && requestedScope !== "commands"
      ? matchingGlobals.slice(0, ACTIONS_CAP)
      : matchingGlobals;
  const shownSub = q ? subActions.filter((a) => matchAction(q, a)) : subActions;
  // Empty query: all saved filters (newest-first from the hook). A query: matches.
  const shownSaved = q
    ? savedQueries.filter((r) => matchSavedQuery(q, r))
    : savedQueries;

  function runSavedFilter(query: string) {
    insertQuery(query);
  }

  // One search box: every query shows matches in the current node and
  // everywhere else together. The rail (desktop) and tabs (phone) only shorten
  // the list; they never change its layout. Home has no narrower place, so
  // "here" falls back to Everywhere there.
  const scope: FindScope =
    requestedScope === "here" && rootId === null ? "all" : requestedScope;
  const hereCount = results?.filter(({ item }) =>
    nearby.has(item.node.id),
  ).length;
  const scopedResults =
    results === null
      ? null
      : scope === "commands"
        ? []
        : scope === "here"
          ? results.filter(({ item }) => nearby.has(item.node.id))
          : results;
  const shownNodes = scopedResults?.slice(0, RESULT_LIMIT) ?? [];
  const shownHere = shownNodes.filter(({ item }) => nearby.has(item.node.id));
  const shownAway = shownNodes.filter(({ item }) => !nearby.has(item.node.id));
  const awayCount = (results?.length ?? 0) - (hereCount ?? 0);
  const showCommands = scope !== "here";
  const canShowInOutline = q !== "" && scope !== "commands";
  const commandCount = q
    ? shownAmbient.length + actions.length + matchingGlobals.length
    : undefined;

  /** The rail, tabs, saved rows, and footer sit inside cmdk's root, whose
   *  Enter selects the highlighted row and whose Tab opens a node's actions.
   *  A focused control keeps those keys; Escape still closes Find, and the
   *  capture handler has already taken Shift+Enter and Cmd+F. */
  function keepKeysHere(event: React.KeyboardEvent) {
    if (event.key !== "Escape") event.stopPropagation();
  }

  function focusInputNow() {
    inputRef.current?.focus({ preventScroll: true });
  }

  function chooseScope(next: FindScope) {
    setScope(next);
    setSelection("");
    requestAnimationFrame(focusInputNow);
  }

  const showInOutline = (
    <Button
      size="xs"
      variant="outline"
      className="font-normal [@media(pointer:coarse)]:min-h-11"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => filterInPlace()}
    >
      <FilterIcon data-icon="inline-start" />
      Show in outline
      <span className="hidden text-muted-foreground sm:inline">⇧↵</span>
    </Button>
  );

  const nodeRows = (rows: typeof shownNodes) =>
    rows.map(({ item, matches }) => (
      <ResultRow
        key={item.node.id}
        index={index}
        node={item.node}
        matches={matches}
        onSelect={go}
        onOpenActions={openActions}
      />
    ));

  const scopeOptions: {
    value: FindScope;
    label: string;
    count: number | undefined;
    icon: ReactNode;
  }[] = [
    {
      value: "all",
      label: "Everywhere",
      count: results?.length,
      icon: <GlobeIcon className="size-4" />,
    },
    ...(rootId === null
      ? []
      : [
          {
            value: "here" as const,
            label: "This node",
            count: hereCount,
            icon: (
              <span className="grid size-4 place-items-center">
                <span className="size-1.5 rounded-full bg-current" />
              </span>
            ),
          },
        ]),
    {
      value: "commands",
      label: "Commands",
      count: commandCount,
      icon: <TerminalIcon className="size-4" />,
    },
  ];

  function onKeyDown(e: React.KeyboardEvent) {
    // Undo and redo in the box edit the query, never the outline behind it.
    // Once Find is closing, the keys belong to the outline again.
    if (open && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      return;
    }
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
        // A saved filter's rename input owns its own keys.
        if (
          actionNodeId ||
          (event.target instanceof HTMLInputElement &&
            event.target !== inputRef.current)
        )
          return;
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          filterInPlace();
        } else if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          chooseScope(rootId === null ? "all" : "here");
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
            actionNodeId
              ? "Filter actions..."
              : scope === "here"
                ? "Search this node..."
                : scope === "commands"
                  ? "Search commands..."
                  : "Search nodes and commands..."
          }
          aria-label={
            actionNodeId ? "Filter actions" : "Find nodes and actions"
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
          <div
            className={cn(
              "flex min-h-0 flex-1",
              !mobile && "mt-1 h-[26rem] border-t",
            )}
          >
            {!mobile && (
              <div
                onKeyDown={keepKeysHere}
                className="no-scrollbar flex w-48 shrink-0 flex-col gap-3 overflow-y-auto border-r p-1 pt-2"
              >
                <RailSection title="Search in">
                  {scopeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={scope === option.value}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseScope(option.value)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted",
                        scope === option.value && "bg-muted text-foreground",
                      )}
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {option.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {option.label}
                      </span>
                      {option.count !== undefined && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {option.count}
                        </span>
                      )}
                    </button>
                  ))}
                </RailSection>
                <RailSection title="Narrow">
                  <QueryFilterChips
                    vertical
                    query={query}
                    onChange={insertQuery}
                  />
                </RailSection>
                {savedQueries.length > 0 && (
                  <RailSection title="Saved">
                    <SavedQueryRows
                      rows={savedQueries}
                      onRun={runSavedFilter}
                      onDone={focusInputNow}
                    />
                  </RailSection>
                )}
              </div>
            )}
            {/* Phones scroll the scope tabs and shortcuts away with the
                results, so a short keyboard viewport keeps its room for rows. */}
            <div
              data-find-scroll=""
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                mobile && "overflow-y-auto overscroll-contain",
              )}
            >
              {mobile && (
                <div onKeyDown={keepKeysHere}>
                  <div
                    role="group"
                    aria-label="Search in"
                    className="flex gap-1.5 overflow-x-auto px-1 pt-2"
                  >
                    {scopeOptions.map((option) => (
                      <Button
                        key={option.value}
                        size="xs"
                        variant={scope === option.value ? "default" : "outline"}
                        aria-pressed={scope === option.value}
                        className="max-w-48 shrink-0 rounded-full font-normal [@media(pointer:coarse)]:min-h-11"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseScope(option.value)}
                      >
                        <span className="truncate">{option.label}</span>
                        {option.count !== undefined && (
                          <span className="tabular-nums opacity-70">
                            {option.count}
                          </span>
                        )}
                      </Button>
                    ))}
                  </div>
                  <QueryFilterChips query={query} onChange={insertQuery} />
                  {canShowInOutline && (
                    <div className="px-1 pb-1">{showInOutline}</div>
                  )}
                </div>
              )}
              <CommandList
                className={cn(
                  "max-h-none",
                  mobile ? "shrink-0 overflow-visible" : "flex-1",
                )}
              >
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
                {showCommands && shownAmbient.length > 0 && (
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

                {showCommands &&
                  (actions.length > 0 || shownGlobals.length > 0) && (
                    <CommandGroup heading="Commands">
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

                {/* Desktop runs typed saved-filter matches from the keyboard; the
                  rail already lists them all. Phones have no rail, so their
                  rows, with rename and delete, follow the list. */}
                {!mobile && q && scope === "all" && shownSaved.length > 0 && (
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
                  scope === "here" ? (
                    <Hint>Type to search this node.</Hint>
                  ) : scope === "all" && bookmarks.length > 0 ? (
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
                  ) : scope === "all" && shownSaved.length === 0 ? (
                    <Hint>
                      No bookmarks yet. Type to search nodes and commands.
                    </Hint>
                  ) : null
                ) : scope === "commands" ? (
                  commandCount === 0 && <Hint>No matching commands.</Hint>
                ) : shownNodes.length === 0 ? (
                  // An unfinished `key:` token shows its suggestions instead.
                  suggestions.length === 0 &&
                  (scope === "here" ||
                    (actions.length === 0 &&
                      shownGlobals.length === 0 &&
                      shownAmbient.length === 0 &&
                      shownSaved.length === 0)) && (
                    <Hint>
                      {scope === "here"
                        ? "No matches in this node."
                        : "No matches."}
                    </Hint>
                  )
                ) : (
                  <>
                    {shownHere.length > 0 && (
                      <CommandGroup heading={`In this node · ${hereCount}`}>
                        {nodeRows(shownHere)}
                      </CommandGroup>
                    )}
                    {shownAway.length > 0 ? (
                      <CommandGroup
                        heading={`${rootId === null ? "Nodes" : "Everywhere else"} · ${awayCount}`}
                      >
                        {nodeRows(shownAway)}
                      </CommandGroup>
                    ) : (
                      scope === "all" &&
                      awayCount > 0 && (
                        // The first 50 rows all matched here; say what is left.
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          Everywhere else · {awayCount} more. Narrow the search
                          to see them.
                        </p>
                      )
                    )}
                  </>
                )}
                {scope === "all" &&
                  results &&
                  exact &&
                  results.length > RESULT_LIMIT && (
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
              {mobile && scope === "all" && shownSaved.length > 0 && (
                <section
                  aria-label="Saved filters"
                  className="p-1"
                  onKeyDown={keepKeysHere}
                >
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {SAVED_FILTERS_HEADING}
                  </div>
                  <SavedQueryRows
                    rows={shownSaved}
                    onRun={runSavedFilter}
                    onDone={focusInputNow}
                  />
                </section>
              )}
            </div>
          </div>
        )}
        {!actionNodeId && !mobile && (
          <div
            onKeyDown={keepKeysHere}
            className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs text-muted-foreground"
          >
            <span>
              <Kbd>↵</Kbd> Open
            </span>
            <span>
              <Kbd>→</Kbd> Actions
            </span>
            {rootId !== null && (
              <span>
                <Kbd>⌘F</Kbd> Search this node
              </span>
            )}
            {canShowInOutline ? (
              <span className="ml-auto">{showInOutline}</span>
            ) : (
              <span>
                <Kbd>⇧↵</Kbd> Show in outline
              </span>
            )}
          </div>
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
      description="Search this node and everywhere at once, run commands, or show matches in the outline."
      className="sm:max-w-[46rem]"
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
        <SearchIcon />
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
        <ChevronLeftIcon />
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

/** Saved filters with rename and delete (ADR 0048 #4, moved into Find by ADR
 *  0089). A row fills Find with its query. Pencil opens an inline name input:
 *  Enter commits, Escape or blur cancels. X deletes. Plain buttons, not cmdk
 *  items, because a row holds three controls; desktop keyboard users reach the
 *  same filters by typing their name. */
function SavedQueryRows({
  rows,
  onRun,
  onDone,
}: {
  rows: readonly SavedQueryRow[];
  onRun: (query: string) => void;
  onDone: () => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  // Focus returns to Find's input before the focused control unmounts, so
  // the dialog's focus guard never takes it.
  const endRename = () => {
    onDone();
    setRenamingId(null);
  };
  return rows.map((row) =>
    renamingId === row.id ? (
      <input
        key={row.id}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        value={nameDraft}
        onChange={(event) => setNameDraft(event.target.value)}
        onKeyDown={(event) => {
          // Keep Enter and Escape away from cmdk and the dialog.
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            renameSavedQuery(row.id, nameDraft);
            endRename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            endRename();
          }
        }}
        onBlur={() => setRenamingId(null)}
        aria-label="Rename saved filter"
        spellCheck={false}
        className="mx-1 rounded border bg-background px-1.5 py-0.5 text-sm"
      />
    ) : (
      <div
        key={row.id}
        className="group/saved flex items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <button
          type="button"
          title={row.query}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRun(row.query)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1 text-left text-sm [@media(pointer:coarse)]:min-h-11"
        >
          <FilterIcon className="size-4 shrink-0" />
          <span className="truncate">{row.name}</span>
        </button>
        <div className="flex shrink-0 items-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/saved:opacity-100 [@media(hover:hover)]:group-hover/saved:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Rename ${row.name}`}
            onClick={() => {
              setNameDraft(row.name);
              setRenamingId(row.id);
            }}
            className="text-muted-foreground [@media(pointer:coarse)]:size-11"
          >
            <PencilIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Delete ${row.name}`}
            onClick={() => {
              onDone();
              deleteSavedQuery(row.id);
            }}
            className="text-muted-foreground [@media(pointer:coarse)]:size-11"
          >
            <CloseIcon />
          </Button>
        </div>
      </div>
    ),
  );
}

function RailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-0.5" aria-label={title}>
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
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
