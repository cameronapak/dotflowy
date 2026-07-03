import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import {
  useHotkey,
  useHotkeys,
  type UseHotkeyDefinition,
} from "@tanstack/react-hotkeys";
import { ChevronRight, HomeIcon, MoreHorizontal, PlusIcon } from "lucide-react";
import {
  getTreeIndex,
  useHasNodes,
  useMirrorCount,
  useNode,
  useTrail,
  useTreeIndex,
  useVisibleChildIds,
  useVisibleRows,
} from "../data/tree-store";
import { isMirrorsEnabled, isVirtualized } from "../data/flags";
import { MirrorBadge } from "./mirror-chrome";
import { scrollRowIntoView, setVirtualNav } from "../data/virtual-nav";
import { OutlineRow } from "./OutlineRow";
import { exposeHotkeyManagerForDev } from "./hotkey-devtools";
import {
  getViewIsHidden,
  getViewRootId,
  useSyncViewState,
} from "../data/view-state";
import { buildTreeIndex, childrenOf, type Node, type TreeIndex } from "../data/tree";
import {
  buildVisibleRows,
  findVisibleNeighbor,
  focusKeyAfterEdit,
  instanceIdForKey,
} from "../data/visible-order";
import { nodesCollection } from "../data/collection";
import { clearSelection } from "../data/selection-state";
import { useSyncSelectionFillRows } from "../data/selection-fill";
import { placeCaretAtEnd, placeCaretAtStart } from "./caret-place";
import { SelectionActionsMenu, useSelectionMode } from "./selection-mode";
import {
  indent,
  insertChildAtStart,
  insertSibling,
  moveDown,
  moveNode,
  moveUp,
  outdent,
  removeNode,
  setIsTask,
  setText,
  toggleCollapsed,
  toggleCompleted,
} from "../data/mutations";
import { bootstrapOutline } from "../data/seed";
import { runStructural } from "../data/structural";
import { capture, drop, redo, undo } from "../data/history";
import { OutlineNode, type NodeCommands } from "./OutlineNode";
import {
  decorate,
  getCaretOffset,
  readSource,
  revealLinkAtCaret,
  watchCaretReveal,
} from "./inline-code";
import { hasLink } from "../data/links";
import {
  copySourceSelection,
  cutSourceSelection,
  pasteIntoBullet,
} from "./paste";
import {
  blocksCaret,
  composeHidden,
  dispatchClick,
  dispatchContextMenu,
  keymapSpecs,
  slotsAt,
  useIsProtected,
  useViewFilter,
} from "../plugins/registry";
import type { PluginContext, SlotSpec, ViewContext } from "../plugins/types";
import { useDragReorder } from "./use-drag-reorder";
import { consumeFlashAfterNav, flashRow } from "./flash-node";
import { healProtectedText } from "./protected-text";
import { guardMirrorSourceDelete, guardProtected, ProtectedLock } from "./protection";
import { Header } from "./Header";
import { Subheader } from "./Subheader";
import { DailyNavigationProgress } from "../plugins/daily/navigation-progress";
import { useShowCompleted } from "./show-completed-provider";
import { openMoveDialog } from "./move-dialog-opener";
import { Button } from "./ui/button";
import { openLinkAtCaret } from "./link-keymap";

// Carry the zoom "pivot" (the node morphing between title and list-item) in
// history state, so the incoming view knows which element to name -- and so it
// can restore focus after the navigation.
declare module "@tanstack/history" {
  interface HistoryState {
    pivotId?: string;
  }
}

interface OutlineEditorProps {
  /**
   * The node to treat as the temporary root ("zoomed in"). When null we
   * render the whole outline from the top. Driven by the URL so zoom state
   * survives reloads and participates in browser back/forward.
   */
  rootId: string | null;
}

// Delegated mousedown for the content container (Seam B). Chips/links live in
// the contentEditable, so a plain mousedown would drop an editing caret; we
// block that when the pointer is over a plugin surface and let onContentClick
// route it. Reads only the event + a module import (no local state), so it sits
// at module scope -- one binding, not a per-render allocation.
function onContentMouseDown(e: ReactMouseEvent) {
  if (blocksCaret(e.target as HTMLElement)) e.preventDefault();
}

// Estimated row height (px) before measureElement corrects it. A one-line bullet
// is ~32px (node-text min-height 24 + row padding); 36 errs slightly tall so the
// initial window over-renders rather than leaving a gap. See ADR 0019.
const ROW_ESTIMATE = 36;

/**
 * Top-level outline editor. Owns:
 *  - reading the live tree
 *  - seeding on first run
 *  - focus management across bullets
 *  - translating keyboard commands into mutations
 *  - the zoom view (breadcrumb + editable title) when rootId is set
 */
export function OutlineEditor({ rootId }: OutlineEditorProps) {
  // React Compiler is OFF for this component (ADR 0019). The windowed list reads
  // `virtualizer.getVirtualItems()` -- data derived from the virtualizer's
  // MUTABLE internal state behind a referentially STABLE instance. The compiler
  // memoizes that read on the stable instance and never recomputes it on scroll,
  // so the rendered window freezes at its initial range. Opting out lets the
  // shell re-render on scroll (as any virtual list must). This is not a hot-path
  // regression: the shell already kept its referential stability by hand
  // (`commands`/`pluginCtx` via useMemo/useCallback, narrow store slices), so
  // rows stay memoized and a keystroke still re-renders only its own bullet.
  "use no memo";
  const navigate = useNavigate();
  const { showCompleted } = useShowCompleted();

  // The shell reads the tree through NARROW slices, never the whole index, so a
  // keystroke in a bullet doesn't re-render the editor itself (ADR 0014): the
  // visible top-level ids (useVisibleChildIds), the zoomed node (useNode), the
  // breadcrumb trail (useTrail), the loaded flag (useHasNodes), and the filter
  // (useViewFilter, live only while filtering). Each re-renders only when its
  // own slice changes identity. Event-time reads (commands, drag, zoom) still go
  // through getTreeIndex() at call time, so those closures stay stable too.

  // First-run import-or-seed bootstrap; safe to run on mount. See seed.ts.
  useBootstrapOutline();

  // DEV-only: expose the hotkey manager so the zoom perf guard can read the live
  // registration count. No-op (and stripped) in production. See hotkey-devtools.ts.
  useEffect(() => {
    exposeHotkeyManagerForDev();
  }, []);

  const routeSearch = useSearch({ strict: false }) as { q?: string };

  // Seam G (ADR 0001): the composed per-node visibility predicate. The core no
  // longer hardcodes `completed` -- it hides whatever the plugin view transforms
  // hide (hide-completed today). Memoized so it stays referentially stable
  // across keystrokes, which keeps useVisibleChildIds' cache warm and every
  // memoized OutlineNode from re-rendering on a sibling's keystroke (ADR 0014).
  // Depends on the whole view context for forward-correctness, though today's
  // only hide rule reads showCompleted.
  const viewCtx = useMemo<ViewContext>(
    () => ({ showCompleted, search: routeSearch, rootId }),
    [showCompleted, routeSearch, rootId],
  );
  const isHidden = useMemo(() => composeHidden(viewCtx), [viewCtx]);
  // Mirror the live view state (zoom root + visibility prune) into view-state's
  // module singleton, so the stable command/drag/zoom closures read it at EVENT
  // time without depending on this render -- the same seam getTreeIndex() gives
  // the tree (ADR 0014). The write runs in an effect, so nothing writes a ref
  // during render. Render reads below use `rootId`/`isHidden` directly.
  useSyncViewState(rootId, isHidden);

  // Focus plumbing: the id->contentEditable registry, the post-render focus/
  // flash pass, and undo/redo (which restore focus where the action left it).
  // The refs are returned so the command closures + drag can write them. See
  // useOutlineFocus.
  const {
    refs,
    registerRef,
    pendingFocus,
    pendingFocusAtStart,
    pendingFlash,
    findFocusedId,
  } = useOutlineFocus();

  // The list container (recursive <ul> or virtualized <div>), so the drag
  // indicator knows how wide to draw and the window virtualizer can measure its
  // document-top offset (scrollMargin).
  const listRef = useRef<HTMLElement | null>(null);
  // The sticky header block above the list. Observed so scrollMargin re-measures
  // when its height changes (tag-filter subheader opening, breadcrumb wrap, the
  // daily-progress bar) without a route remount -- else windowed rows drift by
  // that delta. See the scrollMargin effect below.
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Zoom navigation: the shared-element morph between a node's title and list-
  // item roles, Cmd+, zoom-out, the current pivot id, and the post-navigation
  // focus landing. See useZoomNavigation.
  const { navigateZoom, pivotId } = useZoomNavigation({
    rootId,
    isHidden,
    refs,
    navigate,
    pendingFocus,
    pendingFlash,
  });

  // Delegated tag-chip interaction. Chips live inside contentEditable text, so a
  // plain mousedown would place an editing caret; we block that and route the
  // click to the filter instead. On touch a transient caret may flash before
  // the navigation, which re-prunes the view -- accepted for v1 (ADR 0015).
  // Delegated interaction (Seam B). Chips/links live inside the contentEditable,
  // so the core runs ONE set of handlers on the content container and dispatches
  // to whichever plugin owns the surface under the pointer (registry.ts). The
  // core has zero feature knowledge -- a folded link opens, a tag chip filters,
  // a right-click picks a color, all decided by the plugins. See ADR 0001.
  // (onContentMouseDown is pure and lives at module scope above.)
  const onContentClick = (e: ReactMouseEvent) => {
    dispatchClick(e.target as HTMLElement, pluginCtx(), e);
  };
  const onContentKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    dispatchClick(e.target as HTMLElement, pluginCtx(), {
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
  };
  // A plugin-owned overlay (the tag color picker), mounted once below. The core
  // is a thin host -- the overlay portals + dismisses itself (ADR 0001 Seam B).
  const [overlayNode, setOverlayNode] = useState<ReactNode>(null);
  const onContentContextMenu = (e: ReactMouseEvent) => {
    dispatchContextMenu(e.target as HTMLElement, pluginCtx(), e);
  };

  // Pointer/touch drag to reorder + reparent, hung off each bullet dot. Reads
  // live values through getters (the same ref pattern the commands use), and
  // commits through the one fused `moveNode` mutation. See ADR 0010.
  const drag = useDragReorder({
    getIndex: getTreeIndex,
    getRootId: getViewRootId,
    getIsHidden: getViewIsHidden,
    getRowEl: (key) =>
      (refs.get(key)?.closest(".outline-row") as HTMLElement | null) ??
      null,
    getListEl: () => listRef.current,
    onMove: (grabbedKey, newParentInstanceId, afterSiblingId) =>
      runStructural(() => {
        const index = getTreeIndex();
        const instanceId = instanceIdForKey(grabbedKey);
        // Field split (ADR 0022): dropping under a mirror reparents to its
        // SOURCE, so the moved node windows into every instance. The position
        // (the node itself + its predecessor) stays the instance. Off the flag
        // newParentInstanceId is already a real node, so this is a no-op.
        const newParentId =
          isMirrorsEnabled() && newParentInstanceId
            ? (index.byId.get(newParentInstanceId)?.mirrorOf ??
              newParentInstanceId)
            : newParentInstanceId;
        capture(index, instanceId);
        const moved = moveNode(index, instanceId, newParentId, afterSiblingId);
        if (moved) {
          // Land focus + flash in the instance that was dragged (re-derived from
          // the post-move render walk), not the source's far copy. Bare id off
          // the flag.
          const key = focusKeyFor(instanceId, grabbedKey);
          pendingFocus.current = key;
          // Tint the row it landed on so the eye can find what just moved.
          pendingFlash.current = key;
        } else drop();
      }),
  });
  // Stable references (useCallback([]) inside the hook), safe to close over in
  // the memoized commands below.
  const { startDrag, consumeClick } = drag;

  // The per-bullet command set. Recreating it each render would change a prop
  // on every memoized OutlineNode and re-render the whole tree on every
  // keystroke -- the exact bug ADR 0014 fixes. It stays stable because every
  // live value it needs is read through a ref or is itself stable. See
  // useNodeCommands.
  const commands = useNodeCommands({
    refs,
    pendingFocus,
    pendingFocusAtStart,
    pendingFlash,
    findFocusedId,
    navigateZoom,
    startDrag,
    consumeClick,
  });

  // PluginContext factory (ADR 0001 D8): the promoted command set + tree reads +
  // a small nav surface, handed to plugin interaction handlers (Seam B). Reads
  // the live tree via getTreeIndex() at call time; stable identity.
  const pluginCtx = useCallback(
    (): PluginContext => ({
      tree: getTreeIndex(),
      mutations: commands,
      nav: {
        zoom: (id) => navigateZoom(id, id),
      },
      openOverlay: (node) => setOverlayNode(node),
    }),
    [commands, navigateZoom],
  );

  // Node multi-selection (ADR 0018): the while-selected keyboard handler + the
  // actions menu's ops. Installs window key/mouse listeners only while a
  // selection is active, and clears any stale selection on this view's mount.
  const selection = useSelectionMode({ refs, pendingFocus });

  // The pruned visible-set for the active filter (matches + ancestor context),
  // or null when no filter. A plugin-contributed Seam-G transform (the tags
  // plugin's tag-filter), composed in registry.buildViewFilter. Subscribed via
  // useViewFilter so the shell re-renders on a keystroke ONLY while a filter is
  // live; with no filter its snapshot stays a stable null. Render-time only,
  // never mutates a node (ADR 0015).
  const filter = useViewFilter(viewCtx, isHidden);
  const noMatches = filter !== null && filter.matchIds.size === 0;

  // Top-level visible child ids, read as a stable slice (useVisibleChildIds
  // already applies the composed prune, so it changes identity only on a
  // structural edit -- never on typing). While filtering, keep only the ones on
  // a path to a match. The fade cascade starts fresh here: a completed ancestor
  // above the current view contributes nothing.
  const topLevelIds = useVisibleChildIds(rootId, isHidden);
  const topLevel = filter
    ? topLevelIds.filter((id) => filter.visibleIds.has(id))
    : topLevelIds;
  const zoomedNode = useNode(rootId ?? "") ?? null;
  const trail = useTrail(rootId);
  const hasNodes = useHasNodes();

  // --- Phase B: windowed rendering (ADR 0019) -------------------------------
  // The flat visible list, the window virtualizer over it, and the event-time
  // bridge that lets the stable focus/drag closures scroll an off-screen row in.
  // Hooks run unconditionally (rules of hooks); when the flag is off, count is 0
  // and the recursive <ul> renders instead. Default on (flags.ts) -- the
  // recursive path is the rollback/parity fallback.
  const virtualized = isVirtualized();
  const rows = useVisibleRows(rootId, isHidden, filter);
  // Mirror `rows` into the selection-fill module (2e-2) so each row's own
  // `useSelectionFill` read covers its visible descendants, not just a selected
  // root -- the flat list has no DOM nesting for a root's tint to paint behind
  // its children. See selection-fill.ts.
  useSyncSelectionFillRows(rows);
  // scrollMargin = the list container's distance from the document top (header +
  // title above it). Measured per zoom view; the editor remounts on zoom (route
  // key), so a one-shot mount measure is current. listRef is set in the branch
  // below, so this runs after the list paints once.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const el = listRef.current;
      if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    // Re-measure when the sticky header resizes (the tag-filter subheader is a
    // query-param change, not a remount, so the deps below never fire for it).
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    return () => ro.disconnect();
  }, [rootId, zoomedNode?.id]);
  const virtualizer = useWindowVirtualizer<HTMLLIElement>({
    count: virtualized ? rows.length : 0,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    scrollMargin,
    // Key by the row's render ADDRESS, not its node id: inside a mirror a
    // source's descendant appears under every instance, so its bare id is no
    // longer unique (ADR 0022). `key` equals `id` for every mirror-free row, so
    // the 99% outline keeps today's identity and the virtualizer's measurement
    // cache is unaffected.
    getItemKey: (i) => rows[i]?.key ?? i,
    // Seed the viewport size so the FIRST paint already has a non-empty window.
    // Without it the window virtualizer starts at a 0-height rect and renders no
    // rows until it observes the window a frame later -- a gap that, under heavy
    // load, can outlast a "row is visible" assertion (and shows a blank flash).
    initialRect:
      typeof window !== "undefined"
        ? { width: window.innerWidth, height: window.innerHeight }
        : undefined,
  });
  // row key -> flat index, for virtual-nav's off-screen scroll. Keyed by the
  // render ADDRESS (row.key), not the bare id: a source descendant appears under
  // every instance, so scrollRowIntoView/virtualRowRect must resolve the exact
  // row (ADR 0022). key === id for every mirror-free row, so the lookup is
  // unchanged for the 99% outline. Rebuilt only when the flat list changes
  // identity (structure), not on keystrokes.
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [rows]);
  const rowIndexRef = useRef(rowIndex);
  useEffect(() => {
    rowIndexRef.current = rowIndex;
  }, [rowIndex]);
  // useLayoutEffect (not useEffect): the post-navigation focus/flash effects in
  // useZoomNavigation and FocusPass are passive and read this bridge via
  // scrollRowIntoView. The editor remounts per zoom view, so on a cross-zoom
  // "/move Go" (or zoom-out) the prior editor's cleanup already nulled `nav`;
  // wiring it in the layout phase guarantees it's set before those passive
  // effects run, so an off-screen target is actually scrolled in rather than
  // silently dropped. rowIndexRef is seeded by useRef on mount, so indexOf works
  // here even before its own (passive) sync effect runs.
  useLayoutEffect(() => {
    if (!virtualized) {
      setVirtualNav(null);
      return;
    }
    setVirtualNav({
      scrollToIndex: (i, opts) => virtualizer.scrollToIndex(i, opts),
      indexOf: (id) => rowIndexRef.current.get(id) ?? -1,
      measurementAt: (i) => virtualizer.measurementsCache[i],
    });
    return () => setVirtualNav(null);
  }, [virtualized, virtualizer]);

  // Deep-linked to a node that no longer exists (and the store has loaded).
  if (rootId !== null && zoomedNode === null && hasNodes) {
    return (
      <div className="mx-auto max-w-[720px] p-6">
        <div className="outline-empty">
          That bullet doesn't exist. <Link to="/">Back to top</Link>.
        </div>
      </div>
    );
  }

  return (
    <>
      <FocusPass
        refs={refs}
        pendingFocus={pendingFocus}
        pendingFocusAtStart={pendingFocusAtStart}
        pendingFlash={pendingFlash}
      />
      <SelectionActionsMenu ops={selection.ops} getCtx={pluginCtx} />
      <div className="sticky top-0 z-10 relative" ref={headerRef}>
        <Header getCtx={pluginCtx}>
          <BreadcrumbTrail
            trail={trail}
            rootId={rootId || null}
            onNavigate={navigateZoom}
          />
        </Header>
        <Subheader getCtx={pluginCtx} />
        <DailyNavigationProgress />
      </div>
      {/* Tag chips live inside the bullets' contentEditable, so the click that
          filters is captured here (mousedown blocks the editing caret). */}
      <div
        role="region"
        aria-label="Outline"
        className="mx-auto max-w-[720px] p-6"
        onMouseDown={onContentMouseDown}
        onClick={onContentClick}
        onKeyDown={onContentKeyDown}
        onContextMenu={onContentContextMenu}
      >
        {overlayNode}

        {zoomedNode && (
          <ZoomedTitle
            node={zoomedNode}
            isPivot={pivotId === zoomedNode.id}
            registerRef={registerRef}
            getCtx={pluginCtx}
            onTextChange={(text) => setText(zoomedNode.id, text)}
            onAddChild={() =>
              runStructural(() => {
                const newId = insertChildAtStart(getTreeIndex(), zoomedNode.id);
                pendingFocus.current = newId;
              })
            }
            onArrowDown={() => commands.onMoveFocus(zoomedNode.id, "down")}
          />
        )}

        {noMatches && filter?.emptyMessage ? (
          <div className="outline-empty">{filter.emptyMessage}</div>
        ) : (
          <>
            {virtualized ? (
              <ul
                className="outline-list"
                ref={(el) => {
                  listRef.current = el;
                }}
                style={{
                  position: "relative",
                  height: virtualizer.getTotalSize(),
                }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = rows[vi.index];
                  if (!row) return null;
                  return (
                    <OutlineRow
                      key={vi.key}
                      nodeId={row.id}
                      rowKey={row.key}
                      contentId={row.contentId}
                      isMirror={row.isMirror}
                      capped={row.capped}
                      broken={row.broken}
                      depth={row.depth}
                      railOwnerIds={row.railOwnerIds}
                      ancestorCompleted={row.ancestorCompleted}
                      commands={commands}
                      pluginCtx={pluginCtx}
                      registerRef={registerRef}
                      pivotId={pivotId}
                      isHidden={isHidden}
                      filter={filter}
                      pendingFocus={pendingFocus}
                      pendingFocusAtStart={pendingFocusAtStart}
                      pendingFlash={pendingFlash}
                      index={vi.index}
                      start={vi.start}
                      scrollMargin={virtualizer.options.scrollMargin}
                      measureRef={virtualizer.measureElement}
                    />
                  );
                })}
              </ul>
            ) : (
              <ul
                className="outline-list"
                ref={(el) => {
                  listRef.current = el;
                }}
              >
                {topLevel.map((id) => (
                  <OutlineNode
                    key={id}
                    nodeId={id}
                    commands={commands}
                    pluginCtx={pluginCtx}
                    registerRef={registerRef}
                    pivotId={pivotId}
                    ancestorCompleted={false}
                    isHidden={isHidden}
                    filter={filter}
                  />
                ))}
              </ul>
            )}
            {/* Click in the whitespace below the list adds a new top-level
                bullet. Hidden while filtering -- there's no "add here" then. */}
            {!filter && (
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                onClick={() =>
                  runStructural(() => {
                    const siblings = childrenOf(getTreeIndex(), rootId);
                    const afterId = siblings.length
                      ? siblings[siblings.length - 1]!.id
                      : null;
                    const newId = insertSibling(
                      getTreeIndex(),
                      rootId,
                      afterId,
                    );
                    pendingFocus.current = newId;
                  })
                }
              >
                <PlusIcon />
              </Button>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * First-run bootstrap: seed the welcome bullets when the outline is empty. It
 * awaits the collection's initial load and no-ops unless the server is empty
 * (seed.ts), so this is safe to call unconditionally on mount.
 *
 * bootstrapOutline returns a BootstrapError as a value (not a throw) when
 * the initial D1 load failed -- it detects that deliberately, because the query
 * adapter resolves an empty array (and logs its own error) rather than rejecting
 * on a 500/offline. We log here too for a single, app-level "bootstrap skipped
 * because the load failed" signal, so the seed never runs over a just-
 * unreachable outline. The trailing .catch is a backstop for anything truly
 * unexpected (e.g. a localStorage quota throw) so the mount effect can never
 * produce an unhandled rejection.
 */
function useBootstrapOutline() {
  useEffect(() => {
    bootstrapOutline()
      .then((err) => {
        if (err instanceof Error)
          console.error("Outline bootstrap skipped:", err);
      })
      .catch((err) => console.error("Outline bootstrap threw:", err));
  }, []);
}

interface OutlineFocus {
  /** row key -> contentEditable span. Keyed by the render ADDRESS (row.key), not
   *  the bare id, so a source descendant windowed under two mirrors keeps two
   *  distinct spans (ADR 0022); key === id for every mirror-free row and for the
   *  recursive path, so titles and list items still register uniformly (the
   *  zoomed title registers under rootId, which is its own key). */
  refs: Map<string, HTMLSpanElement | null>;
  registerRef: (key: string, el: HTMLSpanElement | null) => void;
  /** The row key to focus after the next render (most-recently inserted/moved). */
  pendingFocus: RefObject<string | null>;
  /** When an Enter-split moved text into the new bullet, land the caret at its
   *  START, not its end (every other pending-focus wants the end). */
  pendingFocusAtStart: RefObject<boolean>;
  /** Like pendingFocus, but pulses the row's background to mark a just-moved
   *  node (set after a drag/keyboard move). */
  pendingFlash: RefObject<string | null>;
  /** The focused row's key, reverse-looked-up from the registry (stable). */
  findFocusedId: () => string | null;
}

/**
 * Focus plumbing for the editor: the id->span registry, the after-render focus/
 * flash pass, and undo/redo (which restore focus to the node the undone action
 * left it on). Split out of OutlineEditor so the body stays readable; the refs
 * are returned so the command closures and drag can write them. See ADR 0014.
 */
function useOutlineFocus(): OutlineFocus {
  // The refs registry: a stable, mutable id->span Map. useState's lazy
  // initializer builds it exactly once and the identity never changes -- we
  // only ever mutate the Map in place (set/delete), never replace it via the
  // setter -- so it behaves exactly like a ref but WITHOUT reading/writing a
  // ref during render. That ref-in-render is what a lazy-init useRef
  // (`if (!refs) refs = new Map()`) does, and it bails this hook
  // out of React Compiler optimization (react-hooks-js/refs).
  const [refs] = useState(() => new Map<string, HTMLSpanElement | null>());
  // `refs` is a stable useState Map (never replaced), so listing it keeps this
  // callback's identity stable -- registerRef is a prop on every memoized
  // OutlineNode, so it MUST stay referentially stable (ADR 0014).
  const registerRef = useCallback((id: string, el: HTMLSpanElement | null) => {
    if (el) refs.set(id, el);
    else refs.delete(id);
  }, [refs]);

  const pendingFocus = useRef<string | null>(null);
  const pendingFocusAtStart = useRef(false);
  const pendingFlash = useRef<string | null>(null);

  // The post-mutation focus/flash pass lives in <FocusPass> (rendered by the
  // editor), not here. It must run after EVERY tree change -- including a nested
  // reparent that leaves the shell's own slices unchanged, and a text undo (no
  // structural change, but pendingFocus is set) -- and the shell no longer
  // re-renders on every change now that it reads narrow slices (ADR 0014). So
  // the pass subscribes to the whole tree itself, in a null component that's
  // cheap to re-render per change.

  // The currently-focused bullet's row KEY, by reverse-looking-up the registry
  // (covers list items and the zoomed title). The registry is keyed by row.key,
  // so this returns the focused row's address -- equal to the node id for every
  // mirror-free row, and the path address for a row inside a mirror (ADR 0022).
  // Null when focus is outside the outline.
  const findFocusedId = useCallback((): string | null => {
    const active = document.activeElement;
    for (const [key, el] of refs) {
      if (el === active) return key;
    }
    return null;
  }, [refs]);

  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z: undo/redo, owning history over the browser's
  // native contentEditable undo (preventDefault). The focused id is handed in so
  // redo can return focus where the action left it; the restored id becomes the
  // next pending focus.
  // undo/redo replay a snapshot as a mix of insert/update/delete -- the same
  // multi-node relink a structural mutation does, so they ride the same atomic
  // batch (one frame, held until echo). See runStructural / PLAN.md.
  useHotkey(
    "Mod+Z",
    () =>
      runStructural(() => {
        const focusId = undo(getTreeIndex(), findFocusedId());
        if (focusId) pendingFocus.current = focusId;
      }),
    { preventDefault: true },
  );
  useHotkey(
    "Mod+Shift+Z",
    () =>
      runStructural(() => {
        const focusId = redo(getTreeIndex(), findFocusedId());
        if (focusId) pendingFocus.current = focusId;
      }),
    { preventDefault: true },
  );

  return {
    refs,
    registerRef,
    pendingFocus,
    pendingFocusAtStart,
    pendingFlash,
    findFocusedId,
  };
}

/**
 * Runs the post-mutation focus + flash pass. Subscribes to the WHOLE tree
 * (useTreeIndex) so its effect runs after every tree change -- that is what
 * consumes pendingFocus once the just-mutated row has committed to the DOM
 * (refs register during commit, before this passive effect). It renders null,
 * so re-rendering it on every change is nearly free: no DOM, no children, and a
 * no-op effect whenever nothing is pending (the common keystroke case).
 *
 * Why a dedicated component: the editor shell reads narrow slices and no longer
 * re-renders on every change (ADR 0014), so a focus pass hung on the shell's
 * render would miss a nested reparent (top level unchanged) or a text undo
 * (no structural change, but pendingFocus is set). Owning its own whole-tree
 * subscription keeps the pass correct without re-rendering the expensive shell.
 */
function FocusPass({
  refs,
  pendingFocus,
  pendingFocusAtStart,
  pendingFlash,
}: {
  refs: Map<string, HTMLSpanElement | null>;
  pendingFocus: RefObject<string | null>;
  pendingFocusAtStart: RefObject<boolean>;
  pendingFlash: RefObject<string | null>;
}) {
  useTreeIndex();
  useEffect(() => {
    const fid = pendingFocus.current;
    if (fid) {
      const el = refs.get(fid);
      if (el) {
        el.focus();
        if (pendingFocusAtStart.current) placeCaretAtStart(el);
        else placeCaretAtEnd(el);
        pendingFocus.current = null;
        pendingFocusAtStart.current = false;
      } else if (!scrollRowIntoView(fid)) {
        // Not windowed (or the id isn't a visible row): nothing to mount later,
        // so clear to avoid a stuck pending. When windowed and off-screen, leave
        // it set -- OutlineRow claims it in its mount effect once scrolled in.
        pendingFocus.current = null;
        pendingFocusAtStart.current = false;
      }
    }
    const flid = pendingFlash.current;
    if (flid) {
      const el = refs.get(flid);
      if (el) {
        flashRow(el.closest(".outline-row"));
        pendingFlash.current = null;
      } else if (!scrollRowIntoView(flid)) {
        pendingFlash.current = null;
      }
    }
  });
  return null;
}

interface ZoomNavigationArgs {
  rootId: string | null;
  isHidden: (node: Node) => boolean;
  refs: Map<string, HTMLSpanElement | null>;
  navigate: ReturnType<typeof useNavigate>;
  // Focus plumbing, for landing focus on a post-nav row that's off-screen in the
  // windowed list (the row claims pendingFocus/pendingFlash on its mount).
  pendingFocus: RefObject<string | null>;
  pendingFlash: RefObject<string | null>;
}

/**
 * Zoom navigation: the shared-element morph between a node's title and list-item
 * roles, Cmd+, zoom-out, and the focus landing after a navigation. Returns the
 * stable `navigateZoom` and the current pivot id. The mount-only effects rely on
 * the editor remounting per zoom view (its `key={nodeId}`; see the "Zoom + view
 * transitions" section of AGENTS.md).
 */
function useZoomNavigation({
  rootId,
  isHidden,
  refs,
  navigate,
  pendingFocus,
  pendingFlash,
}: ZoomNavigationArgs): {
  navigateZoom: (toRootId: string | null, pivot: string) => void;
  pivotId: string | null;
} {
  // The "pivot" of the last zoom: the node that swaps between title and list-
  // item roles. The incoming view reads it from history state and names that
  // node's element so the browser morphs it across the navigation.
  const location = useLocation();
  const pivotId = location.state.pivotId ?? null;
  // pivotId is read only at event time (navigateZoom's morph-retarget), so
  // mirror it into a ref written AFTER commit -- not during render -- so nothing
  // here trips the React Compiler's ref-during-render bailout. One reader, so a
  // ref is the right size; rootId/isHidden get view-state's store because drag +
  // commands + zoom all read them.
  const pivotIdRef = useRef<string | null>(pivotId);
  useEffect(() => {
    pivotIdRef.current = pivotId;
  }, [pivotId]);

  /**
   * Navigate to a new zoom root with a shared-element morph. `pivot` is the
   * node that changes role: the target when zooming in (list item -> title),
   * the current root when zooming out (title -> list item). We name the pivot in
   * the OUTGOING view here; the incoming view names it declaratively.
   */
  const navigateZoom = useCallback(
    (toRootId: string | null, pivot: string) => {
      // Zooming out reveals the trail: expand any collapsed ancestor between the
      // node we're leaving and the destination root, so the pivot is actually
      // visible when we land (otherwise a collapsed parent hides where you were).
      revealAncestorsToRoot(getTreeIndex(), pivot, toRootId);
      if (prefersReducedMotion()) {
        // No morph, but still carry the pivot so the new view restores focus.
        const state = { pivotId: pivot };
        if (toRootId === null) navigate({ to: "/", state });
        else navigate({ to: "/$nodeId", params: { nodeId: toRootId }, state });
        return;
      }
      // Retarget the morph name from this view's current pivot onto the new one.
      const prev = pivotIdRef.current;
      if (prev && prev !== pivot) {
        const prevEl = refs.get(prev);
        prevEl?.style.removeProperty("view-transition-name");
        prevEl?.classList.remove("vt-morph");
      }
      const el = refs.get(pivot);
      if (el) {
        el.style.setProperty("view-transition-name", "zoom-target");
        el.classList.add("vt-morph");
      }
      const opts = {
        state: { pivotId: pivot },
        viewTransition: { types: ["zoom"] },
      };
      if (toRootId === null) navigate({ to: "/", ...opts });
      else navigate({ to: "/$nodeId", params: { nodeId: toRootId }, ...opts });
    },
    // navigate is stable (useNavigate with no args returns a referentially
    // stable callback), so navigateZoom -- and therefore commands -- keeps its
    // identity across renders. refs is a stable ref object.
    [refs, navigate],
  );

  // Cmd/Ctrl+,: zoom out one level -- navigate to the current root's parent,
  // with the current root as the morph pivot (title -> list item). No-op at the
  // top. Mirror of Cmd+. (zoom in). Keyed off rootId, not the focused node.
  useHotkey(
    "Mod+,",
    () => {
      const currentRoot = getViewRootId();
      if (currentRoot === null) return;
      const node = getTreeIndex().byId.get(currentRoot);
      navigateZoom(node?.parentId ?? null, currentRoot);
    },
    { preventDefault: true },
  );

  // After a zoom, drop focus where the user is most likely to continue:
  //  - Zooming IN (pivotId === rootId): the first visible child of the opened
  //    node, or its title when childless.
  //  - Zooming OUT: the node you came from.
  // Then scroll the target into view if it landed below the fold. Mount-only by
  // design (the editor remounts per zoom view) and passive: each bullet's text
  // is written in OutlineNode's own passive effect, so only by now is the list
  // laid out at its real heights.
  useEffect(() => {
    if (!pivotId) return;
    let targetId = pivotId;
    if (pivotId === rootId) {
      const firstChild = childrenOf(getTreeIndex(), rootId).find(
        (n) => !isHidden(n),
      );
      if (firstChild) targetId = firstChild.id;
    }
    const el = refs.get(targetId);
    if (!el) {
      // Windowed + off-screen (zoom-out can land on a deep node): scroll it in
      // and let OutlineRow claim focus on mount.
      if (scrollRowIntoView(targetId)) pendingFocus.current = targetId;
      return;
    }
    el.focus({ preventScroll: true });
    placeCaretAtEnd(el);
    el.scrollIntoView({ block: "nearest" });
    // Mount-only by design: the editor remounts per zoom view (route key), so
    // the captured values are current at mount. Re-running on any of them would
    // re-steal focus mid-edit -- not a staleness bug.
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, []);

  // /move's "Go" jumps to the destination's zoom view and asks us to focus and
  // flash the moved node so it's easy to spot. Mount-only/passive, like above.
  useEffect(() => {
    const flashId = consumeFlashAfterNav();
    if (!flashId) return;
    const el = refs.get(flashId);
    if (!el) {
      // Windowed + off-screen: scroll in, claim focus + flash on mount.
      if (scrollRowIntoView(flashId)) {
        pendingFocus.current = flashId;
        pendingFlash.current = flashId;
      }
      return;
    }
    el.focus({ preventScroll: true });
    placeCaretAtEnd(el);
    el.scrollIntoView({ block: "nearest" });
    flashRow(el.closest(".outline-row"));
    // Mount-only by design (see above): consumeFlashAfterNav is a one-shot read
    // and refs are stable, so there is nothing reactive to re-run on.
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, []);

  return { navigateZoom, pivotId };
}

/**
 * The render key to focus after a structural edit, re-derived from the LIVE post-
 * edit render walk so the focus key can never drift from what's on screen (ADR
 * 0022, Stage 2c). `instanceId` is the new/moved node; `activeKey` is the row the
 * user was editing — we return the matching instance's key under the same mirror
 * anchor, so a child added to a source lands under the mirror you were in (not the
 * source's far-away copy).
 *
 * Off the flag (the 99% path) a node id is unique, so we return it directly and
 * skip the rebuild entirely. With the flag on we build a fresh index from
 * `nodesCollection.toArray` — synchronously current after `runStructural`, the
 * same technique the structural invariant check uses — rather than
 * `getTreeIndex()`, whose change-notify can lag the optimistic apply.
 */
function focusKeyFor(instanceId: string, activeKey: string): string {
  if (!isMirrorsEnabled()) return instanceId;
  const index = buildTreeIndex(nodesCollection.toArray as Node[]);
  const rows = buildVisibleRows(index, getViewRootId(), getViewIsHidden(), null, true);
  return focusKeyAfterEdit(rows, instanceId, activeKey) ?? instanceId;
}

interface NodeCommandsArgs {
  refs: Map<string, HTMLSpanElement | null>;
  pendingFocus: RefObject<string | null>;
  pendingFocusAtStart: RefObject<boolean>;
  pendingFlash: RefObject<string | null>;
  /** Reverse-lookup of the focused row's key (stable). Caret nav walks from this
   *  so it addresses the right instance inside a mirror (ADR 0022). */
  findFocusedId: () => string | null;
  navigateZoom: (toRootId: string | null, pivot: string) => void;
  startDrag: ReturnType<typeof useDragReorder>["startDrag"];
  consumeClick: ReturnType<typeof useDragReorder>["consumeClick"];
}

/**
 * The per-bullet command set, handed to every OutlineNode. Stable identity
 * (a prop on every memoized node) because every live value it needs is read
 * through a ref or is itself stable. See ADR 0014.
 */
function useNodeCommands({
  refs,
  pendingFocus,
  pendingFocusAtStart,
  pendingFlash,
  findFocusedId,
  navigateZoom,
  startDrag,
  consumeClick,
}: NodeCommandsArgs): NodeCommands {
  return useMemo<NodeCommands>(() => {
    // The `.outline-row` element for a node, for the protection-rejection shake.
    const rowOf = (id: string) =>
      refs.get(id)?.closest(".outline-row") ?? null;
    return {
      onTextChange: (id, text) => {
        // Coalesce a run of keystrokes on one bullet into a single undo step,
        // capturing the pre-typing state on the first keystroke of the run.
        capture(getTreeIndex(), id, `text:${id}`);
        setText(id, text);
      },

      onEnter: (id, caretOffset) => {
        // The new node's id + the row the user was editing, returned from the
        // batch so the focus key can be re-derived from the post-edit render walk
        // AFTER it commits (focusKeyFor reads the settled collection).
        const plan = runStructural(():
          | { instanceId: string; activeKey: string; atStart: boolean }
          | null => {
          // Address the row by its render KEY, not the bare id the keymap passes:
          // inside a mirror the keymap hands over the CONTENT id, so only the
          // focused span's key resolves the right instance (ADR 0022, 2b/2c). The
          // field split (ADR 0022): position (sibling/parent) is LOCAL to the
          // instance; text + children are the SOURCE's content.
          const mirrorsOn = isMirrorsEnabled();
          const activeKey = findFocusedId() ?? id;
          const instanceId = instanceIdForKey(activeKey);
          const idx = getTreeIndex();
          const instance = idx.byId.get(instanceId);
          if (!instance) return null;
          const contentId = mirrorsOn
            ? (instance.mirrorOf ?? instanceId)
            : instanceId;
          const content = idx.byId.get(contentId);
          if (!content) return null;
          const isMirrorRow = contentId !== instanceId;
          capture(idx, activeKey);
          const offset = Math.max(0, Math.min(caretOffset, content.text.length));
          const before = content.text.slice(0, offset);
          const after = content.text.slice(offset);
          // On a mirror's OWN row, Enter never moves text off the source -- the
          // text is the source's content, so a split would either desync every
          // instance or strand the tail on a local node. Treat it as the empty-
          // tail case: add a node, leave the source text whole (ADR 0022, 2c).
          const caretAtEnd = isMirrorRow || after.length === 0;
          // Pressing Enter at the end of an open (expanded, has-children) bullet
          // adds a child at the top of its list rather than a sibling -- you're
          // diving into the thing you just finished naming. "Open" reads the
          // CONTENT's children but the INSTANCE's collapse (collapse is local).
          const isOpen =
            !instance.collapsed && childrenOf(idx, contentId).length > 0;
          let newId: string;
          let atStart = false;
          if (caretAtEnd && isOpen) {
            // Dive in: a child of the CONTENT (source), so the new node windows
            // into every instance, not just the one being edited.
            newId = insertChildAtStart(idx, contentId, content.isTask);
          } else {
            // New sibling beside the INSTANCE (position is local to where the row
            // sits). Off-flag / mirror-free, instance === content === id, so this
            // is byte-identical to the old new-sibling path.
            newId = insertSibling(
              idx,
              instance.parentId,
              instanceId,
              content.isTask,
              isMirrorRow ? "" : after,
            );
            if (!caretAtEnd) {
              setText(contentId, before);
              // Caret sits before the moved text, where the split happened.
              atStart = true;
            }
          }
          return { instanceId: newId, activeKey, atStart };
        });
        if (plan) {
          pendingFocus.current = focusKeyFor(plan.instanceId, plan.activeKey);
          pendingFocusAtStart.current = plan.atStart;
        }
      },

      onIndent: (id) => {
        const plan = runStructural((): { instanceId: string; activeKey: string } | null => {
          // Indent reorders the INSTANCE (position is local, ADR 0022). Inside a
          // mirror the windowed children are real source nodes, so this restructures
          // the source and shows in every instance; on a mirror's own row it moves
          // that mirror, not the source. Address by the focused row's key (the
          // keymap passes the content id inside a mirror).
          const activeKey = findFocusedId() ?? id;
          const instanceId = instanceIdForKey(activeKey);
          // Moving the node reparents it, which drops focus. Re-focus after render.
          capture(getTreeIndex(), activeKey);
          if (indent(getTreeIndex(), instanceId)) return { instanceId, activeKey };
          drop(); // no move happened; discard the redundant undo point
          return null;
        });
        if (plan) {
          const key = focusKeyFor(plan.instanceId, plan.activeKey);
          pendingFocus.current = key;
          pendingFlash.current = key;
        }
      },

      onOutdent: (id) => {
        const plan = runStructural((): { instanceId: string; activeKey: string } | null => {
          const activeKey = findFocusedId() ?? id;
          const instanceId = instanceIdForKey(activeKey);
          // Don't let a direct child of the zoom root outdent past it; that
          // would move it out of the visible subtree and look like it vanished.
          const node = getTreeIndex().byId.get(instanceId);
          if (node && node.parentId === getViewRootId()) return null;
          // Same remount-drops-focus issue as indent; re-focus on a real move.
          capture(getTreeIndex(), activeKey);
          if (outdent(getTreeIndex(), instanceId)) return { instanceId, activeKey };
          drop();
          return null;
        });
        if (plan) {
          const key = focusKeyFor(plan.instanceId, plan.activeKey);
          pendingFocus.current = key;
          pendingFlash.current = key;
        }
      },

      onMoveUp: (id) => {
        const plan = runStructural((): { instanceId: string; activeKey: string } | null => {
          // Move reorders the INSTANCE (position is local, ADR 0022); address by
          // the focused key so a mirror moves itself, not its source.
          const activeKey = findFocusedId() ?? id;
          const instanceId = instanceIdForKey(activeKey);
          // Reorder/outdent remounts the contentEditable; re-focus on a real move.
          capture(getTreeIndex(), activeKey);
          const moved = moveUp(getTreeIndex(), instanceId, {
            isVisible: (n) => !getViewIsHidden()(n),
            rootId: getViewRootId(),
          });
          if (moved) return { instanceId, activeKey };
          drop();
          return null;
        });
        if (plan) {
          const key = focusKeyFor(plan.instanceId, plan.activeKey);
          pendingFocus.current = key;
          pendingFlash.current = key;
        }
      },

      onMoveDown: (id) => {
        const plan = runStructural((): { instanceId: string; activeKey: string } | null => {
          const activeKey = findFocusedId() ?? id;
          const instanceId = instanceIdForKey(activeKey);
          capture(getTreeIndex(), activeKey);
          const moved = moveDown(getTreeIndex(), instanceId, {
            isVisible: (n) => !getViewIsHidden()(n),
            rootId: getViewRootId(),
          });
          if (moved) return { instanceId, activeKey };
          drop();
          return null;
        });
        if (plan) {
          const key = focusKeyFor(plan.instanceId, plan.activeKey);
          pendingFocus.current = key;
          pendingFlash.current = key;
        }
      },

      onDeleteNode: (id) =>
        runStructural(() => {
          // Delete the INSTANCE (position is local, ADR 0022): backspacing a
          // mirror's own row removes that mirror, never its source (which would
          // strand the other instances -- promote-on-source-delete is Stage 3).
          // Address by the focused key; the keymap passes the content id in a
          // mirror.
          const activeKey = findFocusedId() ?? id;
          const instanceId = instanceIdForKey(activeKey);
          const idx = getTreeIndex();
          const mirrorsOn = isMirrorsEnabled();
          const contentId = mirrorsOn
            ? (idx.byId.get(instanceId)?.mirrorOf ?? instanceId)
            : instanceId;
          // A protected node can't be deleted. This is the single funnel every
          // delete path flows through, so the core enforces it here: shake the
          // row + toast why (guardProtected), and bail before removing anything.
          // Protection follows CONTENT (the source); the shake lands on the row
          // the user acted on (the active key). The node isn't removed, so its
          // row still exists.
          if (guardProtected(contentId, "delete", rowOf(activeKey))) return;
          // Deleting a SOURCE would orphan its live mirrors (Stage 3 promotes;
          // v1 blocks). A mirror's own row is never a source, so this no-ops
          // there -- backspacing a mirror still works. Flag-gated: off-flag a
          // mirrorOf node is just a normal node, so the guard never runs.
          if (mirrorsOn && guardMirrorSourceDelete(idx, [instanceId], rowOf(activeKey)))
            return;
          capture(idx, activeKey);
          // Focus the row directly ABOVE the deleted one (Workflowy backspace
          // behavior), computed before the mutation so the neighbor still
          // exists. Fall back to removeNode's structural pick (next sibling /
          // parent) only when nothing is above -- the first visible row.
          const above = findVisibleNeighbor(
            idx,
            getViewRootId(),
            activeKey,
            "up",
            getViewIsHidden(),
            mirrorsOn,
          );
          const focusId = removeNode(idx, instanceId);
          const target = above ?? focusId;
          if (target) pendingFocus.current = target;
          else drop(); // node didn't exist; nothing was deleted
        }),

      onToggleCompleted: (id, completed) => {
        // A protected node can't be marked done (completing it would strike
        // through its whole subtree). This funnel catches every completion path
        // (Mod+Enter / Mod+D on a bullet OR the zoomed title, the todos
        // checkbox). Un-marking (completed=false) is always allowed. See ADR 0015.
        if (completed && guardProtected(id, "complete", rowOf(id))) return;
        capture(getTreeIndex(), id);
        toggleCompleted(id, completed);
      },

      onSetTask: (id, isTask) => {
        // A protected node stays a plain text node -- it can't become a to-do.
        // This funnel catches every task-creation path (`/todo`, the `[]`
        // autoformat). Un-tasking (isTask=false) is always allowed. See ADR 0015.
        if (isTask && guardProtected(id, "task", rowOf(id))) return;
        capture(getTreeIndex(), id);
        setIsTask(id, isTask);
      },

      // Open the move picker; the dialog runs the mutation + navigation itself.
      onRequestMove: (id) => openMoveDialog(id),

      // Same picker in mirror mode; a pick creates a live mirror under the
      // chosen destination instead of reparenting (ADR 0022).
      onRequestMirror: (id) => openMoveDialog(id, "mirror"),

      onToggleCollapsed: (id, collapsed) => {
        capture(getTreeIndex(), id);
        toggleCollapsed(id, collapsed);
        // The windowed list toggles instantly (ADR 0019 dropped the reveal
        // animation), so flash the toggled row to signal something happened --
        // the same "acted-upon" pulse a move gives. See flash-node.ts.
        flashRow(rowOf(id));
      },

      onMoveFocus: (id, direction, x) => {
        // Walk from the FOCUSED row's key, not the bare id the keymap passes:
        // inside a mirror a node id is ambiguous (it renders under every
        // instance), so only the focused span's key addresses the right row. For
        // a mirror-free row findFocusedId() === id, so this is unchanged. Fall
        // back to the passed id when focus is somehow outside the registry.
        const from = findFocusedId() ?? id;
        const target = findVisibleNeighbor(
          getTreeIndex(),
          getViewRootId(),
          from,
          direction,
          getViewIsHidden(),
          isMirrorsEnabled(),
        );
        if (!target) return;
        const el = refs.get(target);
        if (el) {
          el.focus();
          if (x != null) placeCaretAtColumn(el, direction, x);
          else if (direction === "down") placeCaretAtStart(el);
          else placeCaretAtEnd(el);
        } else if (scrollRowIntoView(target)) {
          // Crossed the window edge: the neighbor row isn't mounted. Scroll it
          // in and let its mount effect claim focus (column intent is lost on
          // this rare edge case -- land at the leading edge of the entry side).
          pendingFocus.current = target;
          pendingFocusAtStart.current = direction === "down";
        }
      },

      // Zooming in: the clicked node is the pivot (list item -> title).
      onZoom: (id) => navigateZoom(id, id),

      onBulletPointerDown: (id, e) => startDrag(id, e),

      // The dot's click fires right after pointerup. Suppress the zoom when that
      // press was actually a drag; otherwise zoom as before.
      onBulletClick: (id) => {
        if (consumeClick()) return;
        navigateZoom(id, id);
      },
    };
  },
    // commands MUST keep stable identity (a prop on every memoized OutlineNode,
    // ADR 0014). The live tree is read via getTreeIndex() and the live view
    // state via getViewRootId()/getViewIsHidden() (view-state.ts) at call time,
    // and the remaining live values through refs (refs/pendingFocus/...), so the
    // only real deps are the three stable callbacks; the module getters and the
    // flagged ref captures can't be listed and would defeat the pattern.
    // eslint-disable-next-line react-doctor/exhaustive-deps
    [navigateZoom, startDrag, consumeClick],
  );
}

/**
 * The zoomed node rendered as an editable page title. Mirrors OutlineNode's
 * contentEditable text-sync so the caret is never clobbered during typing.
 */
function ZoomedTitle({
  node,
  isPivot,
  registerRef,
  getCtx,
  onTextChange,
  onAddChild,
  onArrowDown,
}: {
  node: Node;
  isPivot: boolean;
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  /** The PluginContext factory, so the plugin keymap (Seam D) works on the
   *  title too -- Mod+Enter / Mod+D toggle completion of the zoomed node. */
  getCtx: () => PluginContext;
  onTextChange: (text: string) => void;
  onAddChild: () => void;
  onArrowDown: () => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  // Mirror OutlineNode's live inline-`code` decoration so a backtick run in the
  // title renders as a mono chip too. See inline-code.ts and OutlineNode.
  const syncedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const caretWatchRef = useRef<(() => void) | null>(null);
  // The protection rules (no delete/blank/to-do/complete) apply to the zoomed
  // node just as on a list bullet, so it wears the same lock when zoomed in.
  // Reactive: a plugin's protection can load async (mirrors OutlineNode). See
  // ADR 0015.
  const protectedNode = useIsProtected(node.id);

  // Mirror "appears in N places" badge on the zoomed title too (ADR 0022, slice
  // 1d), so a mirrored node shows the chrome whether it's a list bullet or the
  // page title. Session-fixed flag -> no reactive work when mirrors are off.
  const mirrorsOn = isMirrorsEnabled();
  const mirrorCount = useMirrorCount(node.id, mirrorsOn);

  // Plugin slots for the zoomed title (Seam F) plus the two core decorations
  // (protected lock, mirror badge), in ONE list -- the same composition as
  // OutlineRow's `row:before-text`, so the two render paths can't drift (see
  // AGENTS.md "a node renders in TWO paths"). Mirrors OutlineRow's order: slots,
  // then the lock, then the badge.
  const beforeTextSlots: SlotSpec[] = [
    ...slotsAt("title:before-text"),
    {
      id: "core:protected-lock",
      position: "title:before-text",
      render: () => (protectedNode ? <ProtectedLock size={16} /> : null),
    },
    {
      id: "core:mirror-badge",
      position: "title:before-text",
      render: () =>
        mirrorsOn && mirrorCount > 0 ? (
          <MirrorBadge sourceId={node.id} count={mirrorCount} />
        ) : null,
    },
  ];

  useEffect(() => {
    const el = ref.current;
    if (!el || composingRef.current) return;
    if (syncedRef.current === node.text) return;
    const focused = document.activeElement === el;
    const revealOffset = focused ? getCaretOffset(el) : null;
    decorate(el, node.text, revealOffset, focused);
    syncedRef.current = node.text;
  });

  // Title shortcuts, scoped to the title's own contentEditable. Enter adds a
  // first child under the title; ArrowDown drops focus into the first child.
  // The plugin keymap (Seam D) is registered here too, so todos' Mod+Enter /
  // Mod+D toggle completion of the zoomed node just like on a list-item bullet.
  useHotkeys(
    [
      { hotkey: "Enter", callback: () => onAddChild() },
      { hotkey: "ArrowDown", callback: () => onArrowDown() },
      ...keymapSpecs.map((k) => ({
        hotkey: k.hotkey as UseHotkeyDefinition["hotkey"],
        callback: () => {
          const el = ref.current;
          if (k.hotkey === "Mod+Enter" && el && openLinkAtCaret(el)) return;
          k.run(node.id, getCtx());
        },
      })),
    ],
    { target: ref },
  );

  return (
    <h2 className="zoomed-title">
      {beforeTextSlots.map((slot) => (
        <Fragment key={slot.id}>{slot.render(node, getCtx)}</Fragment>
      ))}
      <span
        ref={(el) => {
          ref.current = el;
          registerRef(node.id, el);
        }}
        className={`node-text zoomed-title-text${isPivot ? " vt-morph" : ""}`}
        style={isPivot ? { viewTransitionName: "zoom-target" } : undefined}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        aria-label="Title"
        aria-multiline="true"
        data-completed={node.completed}
        onInput={(e) => {
          const el = e.currentTarget;
          const text = readSource(el);
          onTextChange(text);
          // Re-decorate live, revealing the link under the caret. Suspended
          // during IME composition; compositionend handles that case.
          if (!composingRef.current) {
            decorate(el, text, getCaretOffset(el), true);
            syncedRef.current = text;
          }
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          const el = e.currentTarget;
          const text = readSource(el);
          onTextChange(text);
          decorate(el, text, getCaretOffset(el), true);
          syncedRef.current = text;
        }}
        onPaste={(e) => {
          const el = e.currentTarget;
          const next = pasteIntoBullet(e, el, node.id, getCtx, onTextChange);
          if (next !== null) syncedRef.current = next;
        }}
        // Copy/cut hand back the markdown SOURCE (a folded link's rendered
        // text drops the url half). See copySourceSelection (ADR 0005).
        onCopy={(e) => copySourceSelection(e, e.currentTarget)}
        onCut={(e) => {
          const el = e.currentTarget;
          const next = cutSourceSelection(e, el, onTextChange);
          if (next !== null) syncedRef.current = next;
        }}
        onFocus={(e) => {
          // Caret and node selection are mutually exclusive (ADR 0018): focusing
          // the title leaves selection mode.
          clearSelection();
          // Per-link reveal in the title (ADR 0005): watch the caret, and
          // reveal the link it's currently on. Link-free is a no-op so the
          // native caret stands.
          const el = e.currentTarget;
          caretWatchRef.current?.();
          caretWatchRef.current = watchCaretReveal(
            el,
            () => composingRef.current,
          );
          // Deferred to the next frame so a CLICK at the title's end settles on
          // the folded layout before the link expands; see revealLinkAtCaret.
          if (!hasLink(node.text)) return;
          revealLinkAtCaret(el, (t) => {
            syncedRef.current = t;
          });
        }}
        onBlur={(e) => {
          const el = e.currentTarget;
          caretWatchRef.current?.();
          caretWatchRef.current = null;
          const text = readSource(el);
          // A protected node left empty heals: restore its name + shake/toast.
          const restored = healProtectedText(node.id, text, el);
          if (restored !== null) syncedRef.current = restored;
          else if (hasLink(text)) {
            decorate(el, text, null, false);
            syncedRef.current = text;
          }
        }}
      />
    </h2>
  );
}

/**
 * The breadcrumb trail above a zoomed node. Mirrors Workflowy: when the trail
 * is deep, the middle ancestors collapse into a single "…" control that reveals
 * the hidden crumbs in a dropdown, keeping the row on one line. We always keep
 * the first ancestor after Home (top-level context) and the immediate parent;
 * everything between them collapses. Each crumb truncates with ellipsis when
 * its text is long.
 */
const LEADING = 1;
const TRAILING = 2;

function BreadcrumbTrail({
  trail,
  rootId,
  onNavigate,
}: {
  trail: Node[];
  rootId: string | null;
  onNavigate: (toRootId: string | null, pivot: string) => void;
}) {
  // Only collapse when at least two crumbs would be hidden — folding a single
  // crumb into a "…" saves no space.
  const collapse = trail.length > LEADING + TRAILING + 1;
  const lead = collapse ? trail.slice(0, LEADING) : trail;
  const hidden = collapse ? trail.slice(LEADING, trail.length - TRAILING) : [];
  const tail = collapse ? trail.slice(trail.length - TRAILING) : [];

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {/* Zooming out: the current root is the pivot (title -> list item). */}
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={() => {
          if (rootId === null) return;
          onNavigate(null, rootId);
        }}
      >
        <HomeIcon />
      </Button>
      {rootId &&
        lead.map((ancestor) => (
          <Crumb
            key={ancestor.id}
            ancestor={ancestor}
            rootId={rootId}
            onNavigate={onNavigate}
          />
        ))}
      {rootId && collapse && (
        <CollapsedCrumbs
          hidden={hidden}
          rootId={rootId}
          onNavigate={onNavigate}
        />
      )}
      {rootId &&
        tail.map((ancestor) => (
          <Crumb
            key={ancestor.id}
            ancestor={ancestor}
            rootId={rootId}
            onNavigate={onNavigate}
          />
        ))}
    </nav>
  );
}

function Crumb({
  ancestor,
  rootId,
  onNavigate,
}: {
  ancestor: Node;
  rootId: string;
  onNavigate: (toRootId: string | null, pivot: string) => void;
}) {
  return (
    <span className="crumb">
      <ChevronRight className="sep" size={13} strokeWidth={2} />
      <button
        type="button"
        className="crumb-link"
        onClick={() => onNavigate(ancestor.id, rootId)}
      >
        {ancestor.text || "Untitled"}
      </button>
    </span>
  );
}

/**
 * The collapsed middle of a deep trail. The "…" button reveals the hidden
 * ancestors in a dropdown on hover or keyboard focus (CSS-driven via
 * :hover / :focus-within, so no open/close state to manage).
 */
function CollapsedCrumbs({
  hidden,
  rootId,
  onNavigate,
}: {
  hidden: Node[];
  rootId: string;
  onNavigate: (toRootId: string | null, pivot: string) => void;
}) {
  return (
    <span className="crumb crumb-collapsed">
      <ChevronRight className="sep" size={13} strokeWidth={2} />
      <button
        type="button"
        className="crumb-ellipsis"
        aria-label="Show hidden breadcrumbs"
        aria-haspopup="menu"
      >
        <MoreHorizontal size={14} strokeWidth={2} />
      </button>
      <div className="crumb-dropdown" role="menu">
        {hidden.map((ancestor) => (
          <button
            key={ancestor.id}
            type="button"
            role="menuitem"
            className="crumb-dropdown-item"
            onClick={() => onNavigate(ancestor.id, rootId)}
          >
            {ancestor.text || "Untitled"}
          </button>
        ))}
      </div>
    </span>
  );
}

/**
 * On zoom-out, expand every collapsed ancestor on the path from `pivot` (the
 * node we're leaving) up to — but not including — `toRootId` (the destination
 * root, or null for Home). This makes the trail that led to `pivot` visible in
 * the view we're navigating to.
 *
 * No-op unless `pivot` is actually a descendant of `toRootId` — so zooming IN
 * (pivot === toRootId) and any non-ancestral jump leave collapse state alone.
 */
function revealAncestorsToRoot(
  index: TreeIndex,
  pivot: string,
  toRootId: string | null,
) {
  if (pivot === toRootId) return;
  const collapsedOnPath: string[] = [];
  let current = index.byId.get(pivot)?.parentId ?? null;
  // Guard against corrupted parent chains, mirroring buildTrail.
  let guard = index.byId.size + 1;
  while (current && current !== toRootId && guard-- > 0) {
    const node = index.byId.get(current);
    if (!node) break;
    if (node.collapsed) collapsedOnPath.push(current);
    current = node.parentId ?? null;
  }
  // Only expand if we walked all the way up to the destination root; otherwise
  // pivot wasn't below it and we'd be mangling an unrelated branch.
  if (current !== toRootId) return;
  for (const id of collapsedOnPath) toggleCollapsed(id, false);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Cross-node caret nav preserves the column: drop the caret at the same
// viewport x the user left at, on the line nearest the side they're entering
// from (top line coming down, bottom line coming up). The browser already laid
// the text out, so we ask it which character sits under that point via
// caretPositionFromPoint -- no text-measurement library needed. See ADR 0008.
function placeCaretAtColumn(
  el: HTMLElement,
  direction: "up" | "down",
  x: number,
) {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  // Aim at the vertical middle of the first (down) or last (up) visual line.
  const y =
    direction === "down" ? rect.top + lineH / 2 : rect.bottom - lineH / 2;
  // Keep the probe inside the element so it can't hit a neighbor.
  const clampedX = Math.max(rect.left + 1, Math.min(x, rect.right - 1));

  const hit = caretFromPoint(clampedX, y);
  if (hit && el.contains(hit.node)) {
    const range = document.createRange();
    range.setStart(hit.node, hit.offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return;
  }
  // Probe missed the text (empty bullet, x past the line end): fall back to the
  // edge we entered from.
  if (direction === "down") placeCaretAtStart(el);
  else placeCaretAtEnd(el);
}

// Standard API with a WebKit (caretRangeFromPoint) fallback. Coordinates are
// viewport-relative, matching getBoundingClientRect.
function caretFromPoint(
  x: number,
  y: number,
): { node: Range["startContainer"]; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const legacy = (
    document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint;
  if (legacy) {
    const range = legacy.call(document, x, y);
    return range
      ? { node: range.startContainer, offset: range.startOffset }
      : null;
  }
  return null;
}
