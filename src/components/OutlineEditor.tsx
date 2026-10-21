import {
  useHotkey,
  useHotkeys,
  type UseHotkeyDefinition,
} from "@tanstack/react-hotkeys";
import {
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import {
  defaultRangeExtractor,
  useWindowVirtualizer,
} from "@tanstack/react-virtual";
import { Cause, Effect, Fiber } from "effect";
import {
  ChevronRight,
  HomeIcon,
  LockIcon,
  MoreHorizontal,
  PlusIcon,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";

import type { OutlineSearch } from "../data/tags";
import type {
  PluginContext,
  RouteSearch,
  SlotSpec,
  ViewContext,
} from "../plugins/types";
import type { NodeCommands } from "./node-commands";

import { echoedTextFor } from "../data/collection";
import { setNodeActionBridge } from "../data/command-bridge";
import { embedUrl } from "../data/embed-url";
import { isMirrorsEnabled } from "../data/flags";
import { focusKeyFor } from "../data/focus-key";
import { capture, drop, getHistoryState } from "../data/history";
import { planJoinPrevious } from "../data/join-previous";
import { getLiveNodes } from "../data/live-nodes";
import {
  indent,
  insertChildAtStart,
  insertSibling,
  joinIntoPrevious,
  moveDown,
  moveNode,
  moveUp,
  outdent,
  removeNode,
  setIsTask,
  setKind,
  setLocked,
  setText,
  splitNode,
  toggleCollapsed,
  toggleCompleted,
} from "../data/mutations";
import { flattenNodeText } from "../data/node-links";
import { appRuntime } from "../data/runtime";
import { bootstrapOutline } from "../data/seed";
import { useSyncSelectionFillRows } from "../data/selection-fill";
import { clearSelection } from "../data/selection-state";
import {
  centerAfterMutation,
  centerAfterNavigation,
  holdSpotlightScroll,
} from "../data/spotlight";
import { runStructural } from "../data/structural";
import {
  buildTreeIndex,
  childrenOf,
  countSubtreeNodes,
  trueSourceOf,
  type Node,
} from "../data/tree";
import {
  getTreeIndex,
  useHasNodes,
  useIsLocked,
  useMirrorCount,
  useNode,
  useSyncReady,
  useTrail,
  useTreeIndex,
  useVisibleRows,
} from "../data/tree-store";
import {
  getViewFilter,
  getViewIsHidden,
  getViewRootId,
  setViewSectionRoot,
  useSyncViewFilter,
  useSyncViewState,
} from "../data/view-state";
import {
  setStreamNeighbor,
  setStreamScroller,
  setStreamView,
  streamNeighbor,
  useStreamView,
  type ViewStream,
} from "../data/view-stream";
import { scrollRowIntoView, setVirtualNav } from "../data/virtual-nav";
import {
  buildVisibleRows,
  findVisibleNeighbor,
  instanceIdForKey,
  type VisibleRow,
} from "../data/visible-order";
import { hasMatchMedia, hasResizeObserver, hasWindow } from "../env";
import { useIsMobile } from "../hooks/use-mobile";
import { DailyNavigationProgress } from "../plugins/daily/navigation-progress";
import {
  blocksCaret,
  buildViewFilter,
  commandSpecs,
  composeHidden,
  dispatchClick,
  dispatchContextMenu,
  dispatchPointerCancel,
  dispatchPointerDown,
  dispatchPointerUp,
  externalDropTargets,
  getProtection,
  hasFoldingToken,
  keymapSpecs,
  pluginPreloads,
  usePluginChrome,
  useIsProtected,
  useViewFilter,
} from "../plugins/registry";
import { Backlinks } from "./backlinks";
import { TitleParagraphGlyph } from "./bullet-glyph";
import { caretPosition } from "./caret-menu-utils";
import {
  caretFromPoint,
  placeCaretAtEnd,
  placeCaretAtStart,
} from "./caret-place";
import {
  DELETE_CONFIRM_THRESHOLD,
  openDeleteConfirm,
} from "./delete-confirm-opener";
import { consumeFlashAfterNav, flashRow } from "./flash-node";
import { Header } from "./Header";
import { captureTextHistory, runHistoryRestore } from "./history-restore";
import { exposeHotkeyManagerForDev } from "./hotkey-devtools";
import {
  decorate,
  getCaretOffset,
  getSelectedAtom,
  readSource,
  revealLinkAtCaret,
  setCaretOffset,
  useEditorFeatureDecoration,
  watchCaretReveal,
} from "./inline-code";
import { signalJoinRefusal } from "./join-refusal";
import { openInlineTargetAtCaret } from "./link-keymap";
import { useMenus } from "./menu-engine";
import { MirrorBadge } from "./mirror-chrome";
import { MobileActionsBar, type MobileBarActions } from "./MobileActionsBar";
import { openMoveDialog } from "./move-dialog-opener";
import { NodeBody } from "./node-body";
import { NodeDecorations } from "./NodeDecorations";
import { OutlineLoading } from "./OutlineLoading";
import { INDENT_PX, OutlineRow } from "./OutlineRow";
import {
  copySourceSelection,
  cutSourceSelection,
  installLiteralPasteArm,
  pasteIntoBullet,
} from "./paste";
import {
  applyPendingCaret,
  clearPendingCaretOffset,
  setPendingCaretOffset,
} from "./pending-caret";
import { healProtectedText } from "./protected-text";
import {
  guardLocked,
  guardLockedDelete,
  guardMirrorSourceDelete,
  guardProtected,
  ProtectionIndicator,
} from "./protection";
import { useNativeFormatInput } from "./selection-format";
import { SelectionActionsMenu, useSelectionMode } from "./selection-mode";
import {
  SelectionFormatToolbar,
  type SelectionFormatActions,
} from "./SelectionFormatToolbar";
import { useShowCompleted } from "./show-completed-provider";
import { useSlashMenu } from "./slash-menu";
import { useSpotlightEnabled } from "./spotlight-mode";
import {
  StreamEntryLine,
  StreamFold,
  StreamPlaceholderTitle,
  StreamShell,
} from "./stream-sections";
import { Subheader } from "./Subheader";
import { Button } from "./ui/button";
import {
  ResponsiveMenu as DropdownMenu,
  ResponsiveMenuContent as DropdownMenuContent,
  ResponsiveMenuItem as DropdownMenuItem,
  ResponsiveMenuTrigger as DropdownMenuTrigger,
} from "./ui/responsive-menu";
import { Sheet, SheetContent } from "./ui/sheet";
import { atLineStart } from "./use-bullet-keymap";
import { useCompletionTransition } from "./use-completion-transition";
import { useDragReorder } from "./use-drag-reorder";
import {
  interleaveStream,
  type ListItem,
  useStreamBuild,
  useViewStream,
} from "./use-view-stream";
import {
  toggleHighlightSelection,
  toggleWrapSelection,
  type MarkerPair,
} from "./wrap";

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
  // SAFETY: delegated handler bound to the content element, so target is an element
  if (blocksCaret(e.target as HTMLElement)) e.preventDefault();
}

// Estimated row height (px) before measureElement corrects it. A one-line bullet
// is ~32px (node-text min-height 24 + row padding); 36 errs slightly tall so the
// initial window over-renders rather than leaving a gap. See ADR 0019.
const ROW_ESTIMATE = 36;

// View stream (ADR 0070): sections loaded per step at either edge, and how much
// of the next section's title peeks above the bottom of a section's page.
const STREAM_CHUNK = 14;
const STREAM_PEEK = 96;
const STREAM_ESTIMATE = { title: 72, placeholder: 120, fold: 44, end: 0 };

/** Reveal one node within the horizontal outline canvas without moving the
 * window vertically. The row, not only its text, is the readable unit. */
function revealOutlineRow(target: HTMLElement, onlyIfHidden = false) {
  const row = target.closest<HTMLElement>(".outline-row");
  const viewport = target.closest<HTMLElement>(".outline-canvas-viewport");
  if (!row || !viewport) return;
  const rowRect = row.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const viewportLeft = viewportRect.left + viewport.clientLeft;
  const viewportRight = viewportLeft + viewport.clientWidth;
  if (
    onlyIfHidden &&
    rowRect.right > viewportLeft &&
    rowRect.left < viewportRight
  )
    return;
  if (rowRect.left < viewportLeft) {
    viewport.scrollBy({ left: rowRect.left - viewportLeft });
  } else if (rowRect.right > viewportRight) {
    viewport.scrollBy({ left: rowRect.right - viewportRight });
  }
}

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
  // Spotlight breathing room (ADR 0060): top padding mirrors the bottom
  // `mb-[50vh]` so a short outline floats near the vertical center instead of
  // hugging the header. Steady state only -- the spotlight engine animates
  // the grow/collapse on toggle (one tween driving padding AND scroll, so
  // they never fight). Centering on focus lives in the engine too.
  const spotlight = useSpotlightEnabled();

  // The shell reads the tree through NARROW slices, never the whole index, so a
  // keystroke in a bullet doesn't re-render the editor itself (ADR 0014): the
  // flat visible rows (useVisibleRows), the zoomed node (useNode), the
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

  // SAFETY: URL search params are string-valued, only optional string fields are read
  const routeSearch = useSearch({ strict: false }) as RouteSearch;
  const focusLast = routeSearch.focus === "last";

  // Seam G (ADR 0001): the composed per-node visibility predicate. The core no
  // longer hardcodes `completed` -- it hides whatever the plugin view transforms
  // hide (hide-completed today). Memoized so it stays referentially stable
  // across keystrokes, which keeps useVisibleChildIds' cache warm and every
  // memoized OutlineRow from re-rendering on a sibling's keystroke (ADR 0014).
  // Depends on the whole view context for forward-correctness, though today's
  // only hide rule reads showCompleted.
  // The view reads `q` and `focus` only. The day stream's `?day=` follows the
  // scroll position (ADR 0070) and must not rebuild the visibility prune.
  const viewSearch = useMemo<RouteSearch>(
    () => ({ q: routeSearch.q, focus: routeSearch.focus }),
    [routeSearch.q, routeSearch.focus],
  );
  const viewCtx = useMemo<ViewContext>(
    () => ({ showCompleted, search: viewSearch, rootId }),
    [showCompleted, viewSearch, rootId],
  );
  const isHidden = useMemo(() => composeHidden(viewCtx), [viewCtx]);
  // Mirror the live view state (zoom root + visibility prune) into view-state's
  // module singleton, so the stable command/drag/zoom closures read it at EVENT
  // time without depending on this render -- the same seam getTreeIndex() gives
  // the tree (ADR 0014). The write runs in an effect, so nothing writes a ref
  // during render. Render reads below use `rootId`/`isHidden` directly.
  useSyncViewState(rootId, isHidden);

  // Mod+Shift+V arms the literal paste (ADR 0044). A window listener, not three
  // element ones: bullets AND the zoomed title paste, and the chord has to be
  // seen on its keydown -- the `paste` event that follows carries no modifiers.
  useEffect(() => installLiteralPasteArm(), []);

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

  // The windowed list container, so the drag
  // indicator knows how wide to draw and the window virtualizer can measure its
  // document-top offset (scrollMargin).
  const listRef = useRef<HTMLElement | null>(null);
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const pointerFocus = useRef(false);
  // The sticky header block above the list. Observed so scrollMargin re-measures
  // when its height changes (tag-filter subheader opening, breadcrumb wrap, the
  // daily-progress bar) without a route remount -- else windowed rows drift by
  // that delta. See the scrollMargin effect below.
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Zoom navigation: the shared-element morph between a node's title and list-
  // item roles, Cmd+, zoom-out, the current pivot id, and the post-navigation
  // focus landing. See useZoomNavigation.
  const { navigateZoom, pivotId, rowNavigation } = useZoomNavigation({
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
    if (e.metaKey || e.ctrlKey) {
      // SAFETY: delegated handler bound to the content element, so target is an element
      const textEl = (e.target as HTMLElement).closest<HTMLElement>(
        ".node-text",
      );
      if (textEl && openInlineTargetAtCaret(textEl)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    // SAFETY: delegated handler bound to the content element, so target is an element
    dispatchClick(e.target as HTMLElement, pluginCtx(), e);
  };
  const onContentKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // A hovered chip is an activation target only when it lives inside the
    // node currently being edited -- otherwise an ordinary Space keystroke,
    // with the mouse merely resting over some other row's chip, would open
    // that chip's editor and swallow the space.
    const hovered = e.currentTarget.querySelector<HTMLElement>(
      "[data-bible-ref]:hover",
    );
    const active = document.activeElement;
    const hoveredChip =
      hovered && active instanceof HTMLElement && active.contains(hovered)
        ? hovered
        : null;
    // SAFETY: delegated handler bound to the content element, so target is an element
    const target =
      getSelectedAtom(e.currentTarget) ??
      hoveredChip ??
      (e.target as HTMLElement);
    const rect = target.getBoundingClientRect();
    dispatchClick(target, pluginCtx(), {
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      source: "keyboard",
      key: e.key,
    });
  };
  // A plugin-owned overlay (the tag color picker), mounted once below. The core
  // is a thin host -- the overlay portals + dismisses itself (ADR 0001 Seam B).
  const [overlayNode, setOverlayNode] = useState<ReactNode>(null);
  // Tier-3 side panel content (ADR 0031). Null = closed. Set via ctx.openPanel;
  // mounted in a `Sheet` below (the overflow-to-panel host + future Lane-B home).
  const [panelNode, setPanelNode] = useState<ReactNode>(null);
  const onContentContextMenu = (e: ReactMouseEvent) => {
    // SAFETY: delegated handler bound to the content element, so target is an element
    dispatchContextMenu(e.target as HTMLElement, pluginCtx(), e);
  };
  const onContentPointerDown = (e: ReactPointerEvent) => {
    // SAFETY: delegated handler bound to the content element, so target is an element
    dispatchPointerDown(e.target as HTMLElement, pluginCtx(), {
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType,
      source: "pointer",
    });
  };
  const onContentPointerUp = (e: ReactPointerEvent) => {
    // SAFETY: delegated handler bound to the content element, so target is an element
    dispatchPointerUp(e.target as HTMLElement, pluginCtx(), {
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType,
      source: "pointer",
    });
  };
  const onContentPointerCancel = (e: ReactPointerEvent) => {
    // SAFETY: delegated handler bound to the content element, so target is an element
    dispatchPointerCancel(e.target as HTMLElement, pluginCtx(), {
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType,
      source: "pointer",
    });
  };

  // Pointer/touch drag to reorder + reparent, hung off each bullet dot. Reads
  // live values through getters (the same ref pattern the commands use), and
  // commits through the one fused `moveNode` mutation. See ADR 0010.
  const drag = useDragReorder({
    getIndex: getTreeIndex,
    getRootId: getViewRootId,
    getIsHidden: getViewIsHidden,
    // The active `?q=` filter, so the drag's row model is exactly the filtered
    // rows the render shows (issue #244 / the ADR 0047 amendment).
    getFilter: getViewFilter,
    getRowEl: (key) =>
      // SAFETY: closest returns the matched .outline-row element or null, rows are HTML elements
      (refs.get(key)?.closest(".outline-row") as HTMLElement | null) ?? null,
    getListEl: () => listRef.current,
    getHorizontalScrollEl: () => canvasViewportRef.current,
    getExternalDropTargets: () => externalDropTargets,
    // Resolved only on pointer-up, after the drag hook's own cleanup. Like the
    // delegated Seam-B handlers above, this reads the live event-time context.
    getPluginContext: () => pluginCtx(),
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
        capture(index, instanceId, null, { label: "move" });
        const moved = moveNode(index, instanceId, newParentId, afterSiblingId);
        if (moved) {
          // Land focus + flash in the instance that was dragged (re-derived from
          // the post-move render walk), not the source's far copy. Bare id off
          // the flag.
          const key = focusKeyFor(instanceId, grabbedKey);
          pendingFocus.current = key;
          // Tint the row it landed on so the eye can find what just moved.
          pendingFlash.current = key;
          // Vanish disclosure (issue #244): a drop that lands the node outside
          // the active filter's visible set (e.g. a match-descendant dragged
          // under a non-matching context ancestor, or into a collapsed match)
          // leaves it unrendered -- pendingFlash then harmlessly no-ops. RECOMPUTE
          // the filter against the post-move tree (getViewFilter()'s visibleIds
          // is the pre-move set, so it can't answer this), then toast so the move
          // isn't silent. Fresh index off the live store, the focusKeyFor /
          // paste-resolveSeam technique (getTreeIndex()'s notify can lag).
          if (getViewFilter()) {
            const fresh = buildTreeIndex(getLiveNodes());
            const recomputed = buildViewFilter(fresh, viewCtx, isHidden);
            // Test the post-move render address, not another copy of this node.
            if (recomputed && !recomputed.visibleIds.has(key)) {
              toast("Moved — hidden by the current filter.");
            }
          }
        } else drop();
      }),
  });
  // Stable references (useCallback([]) inside the hook), safe to close over in
  // the memoized commands below.
  const { startDrag, consumeClick } = drag;

  // The per-bullet command set. Recreating it each render would change a prop
  // on every memoized OutlineRow and re-render the whole tree on every
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

  // Live plugin async fibers (ctx.run), interrupted on editor unmount (ADR 0039).
  const runningFibers = useRef(new Set<Fiber.Fiber<void, never>>());

  // PluginContext factory (ADR 0001 D8): the promoted command set + tree reads +
  // a small nav surface, handed to plugin interaction handlers (Seam B). Reads
  // the live tree via getTreeIndex() at call time; stable identity.
  const pluginCtx = useCallback(
    (): PluginContext => ({
      tree: getTreeIndex(),
      mutations: commands,
      nav: {
        zoom: (id) => navigateZoom(id, id),
        // Plain navigation: no `view-transition` opts and no `pivotId` state, so
        // the incoming title carries no stale morph name and the mount focus
        // effect (which keys off pivotId) leaves the caret alone. The content
        // just swaps. See ADR 0054 (the week strip's pill IS the transition).
        open: (id) => navigate({ to: "/$nodeId", params: { nodeId: id } }),
      },
      openOverlay: (node) => setOverlayNode(node),
      openPanel: (node) => setPanelNode(node),
      run: (effect) => {
        const guarded = effect.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              console.error("[plugin] async task failed:", Cause.pretty(cause)),
            ),
          ),
          Effect.asVoid,
        );
        const set = runningFibers.current;
        let fiber: Fiber.Fiber<void, never>;
        fiber = appRuntime.runFork(
          guarded.pipe(Effect.ensuring(Effect.sync(() => set.delete(fiber)))),
        );
        set.add(fiber);
      },
    }),
    [commands, navigateZoom, navigate],
  );

  // Interrupt any still-running plugin fibers when the editor unmounts (ADR 0039).
  useEffect(() => {
    const fibers = runningFibers.current;
    return () => {
      for (const f of fibers) appRuntime.runFork(Fiber.interrupt(f));
    };
  }, []);

  // Publish the node-action surface for the Cmd+K command center (ADR 0034). The
  // switcher is mounted in `__root`, OUTSIDE this editor, so it reads these live
  // through the module bridge. All four are stable identity, so this is a
  // one-shot publish, torn down on unmount (e.g. the login screen).
  useEffect(() => {
    const focusNode = (id: string) => {
      pendingFocus.current = id;
      requestAnimationFrame(() => {
        const el = refs.get(id);
        if (el) {
          el.focus({ preventScroll: true });
          el.scrollIntoView({ block: "nearest" });
          pendingFocus.current = null;
        } else if (!scrollRowIntoView(id)) pendingFocus.current = null;
      });
    };
    setNodeActionBridge({
      commands,
      getCtx: pluginCtx,
      findFocusedId,
      focusNode,
    });
    return () => setNodeActionBridge(null);
  }, [commands, pluginCtx, findFocusedId, refs, pendingFocus]);

  // Zero-arg command surface for the mobile actions bar (ADR 0030). A thin facade
  // over the same `commands`/`undo`/`redo` the keyboard uses; each method resolves
  // the focused bullet internally, so the bar inherits runStructural atomicity,
  // protection guards, and undo coalescing for free. Stable identity.
  const mobileBarActions = useMobileBarActions({
    refs,
    findFocusedId,
    pendingFocus,
    commands,
  });

  // Desktop (fine-pointer) selection formatting toolbar (ADR 0036). Same facade
  // shape as the mobile bar, routed into the emphasis/highlight/link paths.
  const selectionFormatActions = useSelectionFormatActions({
    findFocusedId,
    commands,
    getCtx: pluginCtx,
  });
  const ownsFormatEditable = useCallback(
    (el: HTMLElement) => {
      const key = findFocusedId();
      return key !== null && refs.get(key) === el;
    },
    [findFocusedId, refs],
  );
  useNativeFormatInput(ownsFormatEditable, selectionFormatActions.toggleMarker);

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
  const [focusedFilterKey, setFocusedFilterKey] = useState<string | null>(null);
  const filter = useViewFilter(viewCtx, isHidden, focusedFilterKey);
  // Mirrored for event-time reads: a structural paste asks, after it lands,
  // whether the bullets it created are actually on screen (ADR 0044).
  useSyncViewFilter(filter);
  const noMatches = filter !== null && filter.matchIds.size === 0;

  const zoomedNode = useNode(rootId ?? "") ?? null;
  const hasNodes = useHasNodes();

  // Loading vs empty. `hasNodes` (byId.size > 0) can't tell "still syncing" from
  // "genuinely empty new account" -- both are zero rows -- which is what made the
  // outline flash from empty to full on first paint. `useSyncReady` flips once,
  // when the first frame lands, so we hold a skeleton until then instead of
  // painting an empty list that a moment later fills in.
  const syncReady = useSyncReady();
  const loading = !syncReady;
  // One-shot reveal latch, scoped to THIS editor instance. We only fade the real
  // content in when it directly replaces a skeleton (i.e. this mount actually
  // showed a loading state). The editor remounts per zoom route, and `syncReady`
  // is already true by then, so a later zoom never showed a skeleton and never
  // fades -- the zoom morph owns that transition. A monotonic ref latch, safe to
  // set in render (this component opts out of React Compiler; see "use no memo").
  const showedSkeletonRef = useRef(false);
  if (loading) showedSkeletonRef.current = true;
  const revealOnLoad = !loading && showedSkeletonRef.current;

  // Spotlight centering for a childless zoom (ADR 0060): zooming into a node
  // with no children leaves a lone title at the top of an empty page, so slide
  // it to the vertical center instead. A zoom WITH children keeps the title at
  // the top -- the children are the content. Runs once per zoom/spotlight
  // flip; later tree edits never re-center the view under the user.
  useEffect(() => {
    if (!spotlight || loading || zoomedNode === null) return;
    if (childrenOf(getTreeIndex(), zoomedNode.id).length > 0) return;
    const el = refs.get(zoomedNode.id);
    if (el) centerAfterNavigation(el);
  }, [spotlight, loading, zoomedNode, refs]);

  // --- Windowed rendering (ADR 0019) ----------------------------------------
  // The flat visible list, the window virtualizer over it, and the event-time
  // bridge that lets the stable focus/drag closures scroll an off-screen row in.
  // A zoomed root a plugin continues into neighboring roots reads as one
  // stream (ADR 0070): the day stream around a daily note. A filter shows the
  // single root, because a filter transforms one root.
  const stream = useViewStream(rootId, filter === null);
  // `?day=` on load: start the stream there. Planned once, when the stream is
  // first ready -- on a cold load the daily index arrives after the first
  // render, so the plan waits for it. Later writes follow the scroll position
  // and must not move it.
  const [initial] = useState(() =>
    stream ? planStreamOpening(stream, routeSearch.day ?? null) : null,
  );
  const [range, setRange] = useState(
    initial?.range ?? planStreamOpening(null, null).range,
  );
  // Sections the user unfolded or worked in. They stay visible even while
  // empty, so a fold never swallows the section holding the caret.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const streamSnapshot = useStreamBuild(
    stream,
    range.before,
    range.after,
    isHidden,
    expanded,
  );
  // The plain zoom list. Under a stream its rows come from the stream build,
  // so this walks nothing (an id no node has).
  const zoomRows = useVisibleRows(stream ? "" : rootId, isHidden, filter);
  const rows = stream ? streamSnapshot.rows : zoomRows;
  // The section under the sticky header drives the breadcrumb (and the week
  // strip, through the same store). A nodeless section borrows its nearest
  // existing ancestor's trail.
  const streamView = useStreamView();
  const inViewSection =
    stream && streamView?.anchor === stream.anchor ? streamView.inView : null;
  const trailRoot =
    stream && inViewSection
      ? (stream.resolve(inViewSection) ?? stream.trailFor(inViewSection))
      : rootId;
  const trail = useTrail(trailRoot);
  const deepestVisibleDepth = useMemo(
    () => rows.reduce((deepest, row) => Math.max(deepest, row.depth), 0),
    [rows],
  );
  const measurements = useRef<readonly { start: number; size: number }[]>([]);
  const onHiddenFocus = useCallback(
    (previous: VisibleRow[], next: VisibleRow[], exiting: Set<string>) => {
      const active = document.activeElement;
      const focused = previous.findIndex((row) => {
        const el = refs.get(row.key);
        return exiting.has(row.key) && !!el?.closest("li")?.contains(active);
      });
      if (focused < 0) return;
      const nextKeys = new Set(next.map((row) => row.key));
      const target =
        previous.slice(focused + 1).find((row) => nextKeys.has(row.key)) ??
        previous
          .slice(0, focused)
          .reverse()
          .find((row) => nextKeys.has(row.key));
      const key = target?.key ?? rootId;
      if (key) {
        const el = refs.get(key);
        if (el) {
          el.focus({ preventScroll: true });
          placeCaretAtStart(el);
        } else {
          pendingFocus.current = key;
          pendingFocusAtStart.current = true;
          scrollRowIntoView(key);
        }
      } else {
        // A genuinely empty Home still has its add control. A filtered empty
        // view instead returns focus to the filter, which can reveal more nodes.
        const add =
          listRef.current?.parentElement?.querySelector<HTMLButtonElement>(
            "[data-outline-add]",
          );
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Filter query"]',
        );
        (add ?? input)?.focus({ preventScroll: true });
      }
    },
    [refs, rootId, pendingFocus, pendingFocusAtStart],
  );
  const streamSectionsRef = useRef(streamSnapshot.sections);
  useLayoutEffect(() => {
    streamSectionsRef.current = streamSnapshot.sections;
  });
  const eligibleRows = useCallback(() => {
    const index = getTreeIndex();
    const neverHidden = () => false;
    if (stream) {
      return streamSectionsRef.current.flatMap((section) =>
        section.kind === "node"
          ? buildVisibleRows(
              index,
              section.nodeId,
              neverHidden,
              null,
              isMirrorsEnabled(),
            )
          : [],
      );
    }
    return buildVisibleRows(
      index,
      rootId,
      neverHidden,
      buildViewFilter(index, viewCtx, neverHidden),
      isMirrorsEnabled(),
    );
  }, [rootId, viewCtx, stream]);
  const presentation = useCompletionTransition({
    rows,
    eligibleRows,
    query: routeSearch.q,
    elements: refs,
    listRef,
    measurements,
    onHiddenFocus,
  });
  const renderedRows = presentation.rows;
  // The windowed list: the presented rows, plus section chrome in a stream.
  const items = useMemo<ListItem[]>(
    () =>
      stream
        ? interleaveStream(
            streamSnapshot.sections,
            streamSnapshot.rowSection,
            renderedRows,
          )
        : renderedRows.map((row) => ({ kind: "row", key: row.key, row })),
    [stream, streamSnapshot, renderedRows],
  );
  const previousVisibleDepth = useRef(deepestVisibleDepth);
  // Expansion preserves the view. After collapse's native clamp, reveal the
  // focused parent only if it is completely outside the remaining viewport.
  useLayoutEffect(() => {
    const shrank = deepestVisibleDepth < previousVisibleDepth.current;
    previousVisibleDepth.current = deepestVisibleDepth;
    if (!shrank) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) revealOutlineRow(active, true);
  }, [deepestVisibleDepth]);
  // Mirror `rows` into the selection-fill module (2e-2) so each row's own
  // `useSelectionFill` read covers its visible descendants, not just a selected
  // root -- the flat list has no DOM nesting for a root's tint to paint behind
  // its children. See selection-fill.ts.
  useSyncSelectionFillRows(rows);

  // Landing the caret when spotlight turns ON (ADR 0060): a node already
  // holding focus keeps it (the engine centers it); otherwise the zoom root's
  // title, else the first VISIBLE row, gets the caret at line start. The
  // rows[0] here is the true first row -- a DOM query would find the first
  // MOUNTED row, which mid-scroll is some middle bullet. A mounted target
  // focuses directly; an off-window first row rides the same pendingFocus
  // mount-claim path a structural edit uses. The prev-ref latch keeps this to
  // the flip event: mounting with the mode already on (page load, zoom) never
  // yanks the caret.
  const prevSpotlight = useRef(spotlight);
  useEffect(() => {
    // Hold the flip while the skeleton is up: consuming the latch during
    // loading would strand the caret landing (the effect re-fires once data
    // arrives, finds `was === true`, and returns -- no lit line, ever).
    if (loading) return;
    const was = prevSpotlight.current;
    prevSpotlight.current = spotlight;
    if (!spotlight || was) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains("node-text"))
      return;
    const key = zoomedNode ? zoomedNode.id : (rows[0]?.key ?? null);
    if (!key) return;
    pendingFocus.current = key;
    pendingFocusAtStart.current = true;
    const el = refs.get(key);
    if (el) {
      el.focus();
      applyPendingCaret(el, key, true);
      pendingFocus.current = null;
      pendingFocusAtStart.current = false;
    } else if (!scrollRowIntoView(key)) {
      pendingFocus.current = null;
      pendingFocusAtStart.current = false;
      clearPendingCaretOffset();
    }
  }, [
    spotlight,
    loading,
    zoomedNode,
    rows,
    refs,
    pendingFocus,
    pendingFocusAtStart,
  ]);
  // scrollMargin = the list container's distance from the document top (header +
  // title above it). Measured per zoom view; the editor remounts on zoom (route
  // key), so a one-shot mount measure is current. listRef is set in the branch
  // below, so this runs after the list paints once.
  const [scrollMargin, setScrollMargin] = useState(0);
  // The sticky header's height: a stream aligns sections just below it.
  const [headerHeight, setHeaderHeight] = useState(0);
  // The tallest the header has been in this view. Pages size from it, so a
  // header that shrinks for a moment (the week strip collapsing while the
  // daily index re-syncs) does not resize every page above the day in view.
  const [pageHeader, setPageHeader] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(() =>
    hasWindow() ? window.innerHeight : 0,
  );
  // One section's page: a screen below the header, minus a peek of the next
  // section's title.
  const streamPage = viewportHeight - pageHeader - STREAM_PEEK;
  // The first index of each section's items, for page-end sizing.
  const sectionStarts = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((item, i) => {
      if (item.kind === "title" || item.kind === "placeholder")
        m.set(item.section, i);
    });
    return m;
  }, [items]);
  useLayoutEffect(() => {
    const measure = () => {
      const el = listRef.current;
      if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
      const next = headerRef.current?.offsetHeight ?? 0;
      setHeaderHeight(next);
      setPageHeader((prev) => Math.max(prev, next));
      setViewportHeight(window.innerHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    // Re-measure when the sticky header resizes (the tag-filter subheader is a
    // query-param change, not a remount, so the deps below never fire for it).
    const header = headerRef.current;
    const ro = hasResizeObserver() ? new ResizeObserver(measure) : null;
    if (header) ro?.observe(header);
    const titleBody = document.querySelector("[data-title-body]");
    if (titleBody) ro?.observe(titleBody);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [rootId, zoomedNode?.id, stream]);
  // row key -> flat index, for virtual-nav's off-screen scroll. Keyed by the
  // render ADDRESS (row.key), not the bare id: a source descendant appears under
  // every instance, so scrollRowIntoView/virtualRowRect must resolve the exact
  // row (ADR 0022). key === id for every mirror-free row, so the lookup is
  // unchanged for the 99% outline. Rebuilt only when the flat list changes
  // identity (structure), not on keystrokes.
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((item, i) => {
      if (item.kind !== "row" || !presentation.exiting.has(item.key))
        m.set(item.key, i);
    });
    return m;
  }, [items, presentation.exiting]);
  // The item a stream load holds in place on screen (see maybeExtend).
  const heldRef = useRef<{
    key: string;
    top: number;
    scrollY: number;
  } | null>(null);
  // Navigation owns the title, not the caret it optionally lands. Keep that
  // ownership through lazy measurements until a new user gesture takes over.
  const titleAnchorRef = useRef<{
    section: string;
    focusKey?: string;
    releaseSpotlight: () => void;
  } | null>(null);
  // A stream load is dispatched and not yet committed (see maybeExtend).
  const extendingRef = useRef(false);
  const releaseTitle = useCallback(() => {
    const anchor = titleAnchorRef.current;
    anchor?.releaseSpotlight();
    titleAnchorRef.current = null;
    headerRef.current?.removeAttribute("data-title-anchored");
    // A dispatched load can commit after this release. Keep its correction: a
    // reading hold stays, and a held title stays where it is as a reading row.
    if (!extendingRef.current) heldRef.current = null;
    else if (anchor) {
      const i = sectionStartsRef.current.get(anchor.section);
      const el =
        i === undefined
          ? null
          : listRef.current?.querySelector<HTMLElement>(
              `:scope > li[data-index="${i}"]`,
            );
      heldRef.current =
        el && i !== undefined
          ? {
              key: itemsRef.current[i]!.key,
              top: el.getBoundingClientRect().top,
              scrollY: window.scrollY,
            }
          : null;
    }
    return anchor !== null;
  }, []);
  useLayoutEffect(() => {
    if (!stream) releaseTitle();
  }, [stream, releaseTitle]);
  useLayoutEffect(
    () => () => {
      releaseTitle();
      openedStreamRef.current = false;
      landedLastRef.current = null;
    },
    [releaseTitle],
  );
  const stopSnapRef = useRef<(() => void) | null>(null);
  // A new getItemKey invalidates the virtualizer's geometry for EVERY loaded
  // item, even when the keys are unchanged. Scroll-only renders must reuse it.
  // Rotate both callbacks when page geometry changes: estimateSize alone is
  // not a measurement-cache dependency in TanStack Virtual.
  const sizing = useMemo(
    () => ({
      getItemKey: (i: number) => items[i]?.key ?? i,
      estimateSize: (i: number) => {
        const item = items[i];
        if (!item || item.kind === "row") return ROW_ESTIMATE;
        if (item.kind !== "end") return STREAM_ESTIMATE[item.kind];
        // Estimate an unmeasured section at its full page height, so loading
        // earlier sections does not move the day in view.
        const first = sectionStarts.get(item.section);
        if (first === undefined) return 0;
        let above = 0;
        for (let j = first; j < i; j++) {
          const prior = items[j]!;
          above +=
            prior.kind === "row" ? ROW_ESTIMATE : STREAM_ESTIMATE[prior.kind];
        }
        return Math.max(0, streamPage - above);
      },
    }),
    [items, sectionStarts, streamPage],
  );
  const virtualizer = useWindowVirtualizer<HTMLLIElement>({
    // Keep the row holding the caret mounted even outside the window. Loading
    // sections above it renders once at the old scroll offset before the
    // offset is corrected; unmounting the focused row there would drop the
    // caret (ADR 0070).
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      // Only a stream needs this; outside one a focused row scrolled out of
      // the window unmounts as before (a filter relies on it).
      if (!stream) return indexes;
      // The same for the item a stream load is holding in place.
      const anchor = titleAnchorRef.current;
      const keep = [
        hasWindow() ? findFocusedId() : null,
        heldRef.current?.key,
        anchor?.focusKey,
      ]
        .map((key) => (key ? rowIndex.get(key) : undefined))
        .concat(anchor ? sectionStarts.get(anchor.section) : undefined)
        .filter((i): i is number => i !== undefined && !indexes.includes(i));
      return keep.length
        ? [...new Set([...indexes, ...keep])].sort((a, b) => a - b)
        : indexes;
    },
    count: items.length,
    ...sizing,
    // A stream scrolls sections to just below the sticky header.
    scrollPaddingStart: stream ? headerHeight : 0,
    overscan: 8,
    scrollMargin,
    // Seed the viewport size so the FIRST paint already has a non-empty window.
    // Without it the window virtualizer starts at a 0-height rect and renders no
    // rows until it observes the window a frame later -- a gap that, under heavy
    // load, can outlast a "row is visible" assertion (and shows a blank flash).
    initialRect: hasWindow()
      ? { width: window.innerWidth, height: window.innerHeight }
      : undefined,
  });
  const virtualItems = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    // A provider can finish loading while the user types farther down the
    // outline. Anchor that editor, not only rows above the viewport.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      _delta,
      instance,
    ) => {
      if (titleAnchorRef.current || heldRef.current) return false;
      const focused =
        document.activeElement?.closest<HTMLElement>("li[data-index]");
      const editing = document.activeElement?.matches(".node-text");
      if (editing && focused) return item.index < Number(focused.dataset.index);
      return item.start < (instance.scrollOffset ?? 0);
    };
    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [virtualizer]);
  useLayoutEffect(() => {
    measurements.current = virtualizer.measurementsCache;
    presentation.animateMounted();
  });
  // A virtualized row can disconnect without bubbling blur. Reconcile after
  // refs finish detaching/reattaching, not during an inline ref's transient null.
  useLayoutEffect(() => {
    if (focusedFilterKey !== null && findFocusedId() !== focusedFilterKey) {
      setFocusedFilterKey(null);
    }
  }, [focusedFilterKey, findFocusedId, filter, virtualItems]);

  const presentationReady = useMemo(
    () => rows.every((row) => rowIndex.has(row.key)),
    [rows, rowIndex],
  );
  const rowIndexRef = useRef(rowIndex);
  useLayoutEffect(() => {
    rowIndexRef.current = rowIndex;
  }, [rowIndex]);
  // useLayoutEffect (not useEffect): the post-navigation focus/flash effects in
  // useZoomNavigation and FocusPass are passive and read this bridge via
  // scrollRowIntoView. The editor remounts per zoom view, so on a cross-zoom
  // "/move Go" (or zoom-out) the prior editor's cleanup already nulled `nav`;
  // wiring it in the layout phase guarantees it's set before those passive
  // effects run, so an off-screen target is actually scrolled in rather than
  // silently dropped. The row index is also published in the layout phase,
  // before a focus pass can resolve a newly inserted or reparented address.
  useLayoutEffect(() => {
    setVirtualNav({
      scrollToIndex: (i, opts) => virtualizer.scrollToIndex(i, opts),
      indexOf: (id) => rowIndexRef.current.get(id) ?? -1,
      measurementAt: (i) => virtualizer.measurementsCache[i],
    });
    return () => setVirtualNav(null);
  }, [virtualizer]);

  // --- View stream behavior (ADR 0070) ---------------------------------------
  // Event-time reads go through refs, like the commands: the scroll listener
  // and bridges stay mounted across renders.
  const itemsRef = useRef(items);
  const sectionStartsRef = useRef(sectionStarts);
  const streamRef = useRef(stream);
  const snapshotRef = useRef(streamSnapshot);
  const headerHeightRef = useRef(headerHeight);
  const rangeRef = useRef(range);
  useLayoutEffect(() => {
    itemsRef.current = items;
    sectionStartsRef.current = sectionStarts;
    streamRef.current = stream;
    snapshotRef.current = streamSnapshot;
    headerHeightRef.current = headerHeight;
    rangeRef.current = range;
  });

  /** The section whose start sits at or above the sticky header's bottom. */
  const sectionInView = useCallback((): string | null => {
    const cache = virtualizer.measurementsCache;
    const line = window.scrollY + headerHeightRef.current + 48;
    let found: string | null = null;
    for (const [section, i] of sectionStartsRef.current) {
      const m = cache[i];
      if (!m) break;
      if (m.start > line) {
        found ??= section;
        break;
      }
      found = section;
    }
    return found;
  }, [virtualizer]);

  // Load more sections near either edge. Prepending holds the item at the top
  // of the viewport in place: the layout effect below scrolls by exactly the
  // height the new sections added above it.
  const deferPrependRef = useRef(false);
  // The section the stream opens on, and the `?day=` still being restored.
  // While a restore is pending the URL keeps its `?day=` (see the URL effect).
  const routeSearchDayRef = useRef(initial?.day ?? null);
  const restoringDayRef = useRef(initial?.day ?? null);
  const plannedRef = useRef(initial !== null);
  const latestSearchDayRef = useRef(routeSearch.day ?? null);
  latestSearchDayRef.current = routeSearch.day ?? null;
  const maybeExtend = useCallback(() => {
    if (!streamRef.current || extendingRef.current) return;
    // Native sheets capture the document offset on entry. A background prepend
    // moves that stage out of view and dismisses it; resume on the next scroll.
    if (document.querySelector(".menu-sheet-overlay")) return;
    const snapshot = snapshotRef.current;
    const list = itemsRef.current;
    const cache = virtualizer.measurementsCache;
    const first = cache[0];
    const last = cache[cache.length - 1];
    if (!first || !last || cache.length !== list.length) return;
    const y = window.scrollY;
    const vh = window.innerHeight;
    if (!snapshot.atStart && y - first.start < vh * 1.5) {
      // iOS cancels momentum on a programmatic scroll write. Defer insertion
      // AND its compensation until idle, not just the compensating scroll.
      if (deferPrependRef.current) return;
      const top = y + headerHeightRef.current;
      let held = 0;
      for (let i = 0; i < cache.length; i++) {
        if (cache[i]!.start <= top) held = i;
        else break;
      }
      // Page-end padding and folded runs can change during a prepend. Hold
      // the next content row instead, through all of its late measurements.
      while (
        held < list.length - 1 &&
        (list[held]!.kind === "end" || list[held]!.kind === "fold")
      )
        held++;
      if (!titleAnchorRef.current && !heldRef.current) {
        const el = listRef.current?.querySelector<HTMLElement>(
          `:scope > li[data-index="${held}"]`,
        );
        heldRef.current = {
          key: list[held]!.key,
          top: el ? el.getBoundingClientRect().top : cache[held]!.start - y,
          scrollY: y,
        };
      }
      extendingRef.current = true;
      setRange((r) => ({ ...r, before: r.before + STREAM_CHUNK }));
    } else if (
      !snapshot.atEnd &&
      last.start + last.size - (y + vh) < vh * 1.5
    ) {
      extendingRef.current = true;
      setRange((r) => ({ ...r, after: r.after + STREAM_CHUNK }));
    }
  }, [virtualizer]);
  useLayoutEffect(() => {
    extendingRef.current = false;
    // Keep loading while still near an edge (a short stretch, or the first
    // load above the anchor right after mount).
    const frame = requestAnimationFrame(maybeExtend);
    return () => cancelAnimationFrame(frame);
    // Runs once per committed range change: `items` is that range's list.
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, [range, stream]);

  const jumpToSection = useCallback(
    (key: string, focusKey?: string) => {
      const active = streamRef.current;
      const offset = active?.offsetOf(key);
      if (offset === null || offset === undefined) return false;
      releaseTitle();
      stopSnapRef.current?.();
      titleAnchorRef.current = {
        section: key,
        focusKey,
        releaseSpotlight: holdSpotlightScroll(),
      };
      headerRef.current?.setAttribute("data-title-anchored", "");
      restoringDayRef.current = null;
      heldRef.current = null;
      // Stop an already-running native smooth snap before seating the title.
      window.scrollTo({ top: window.scrollY, behavior: "instant" });
      const { before, after } = rangeRef.current;
      if (offset < -before || offset > after)
        setRange({
          before: Math.max(before, -offset + STREAM_CHUNK),
          after: Math.max(after, offset + STREAM_CHUNK),
        });
      // Also commit an already expanded target: its title and optional offscreen
      // focus row must enter the virtual range before the layout effect runs.
      setExpanded((prev) => new Set(prev).add(key));
      return true;
    },
    [releaseTitle],
  );

  // Cold load: the stream became ready after mount. Plan the opening now.
  useLayoutEffect(() => {
    if (!stream || plannedRef.current) return;
    plannedRef.current = true;
    const plan = planStreamOpening(stream, latestSearchDayRef.current);
    routeSearchDayRef.current = plan.day;
    restoringDayRef.current = plan.day;
    setRange(plan.range);
  }, [stream]);
  const openedStreamRef = useRef(false);
  useLayoutEffect(() => {
    if (!stream || openedStreamRef.current) return;
    openedStreamRef.current = true;
    // Zoom/pivot and /move -> Go own a row landing, including when the stream
    // mapping arrives later. The navigation hook records that intent first.
    if (rowNavigation.current) return;
    jumpToSection(routeSearchDayRef.current ?? stream.anchor);
    restoringDayRef.current = routeSearchDayRef.current;
  }, [stream, jumpToSection, rowNavigation]);

  // One correction owns measurements: a navigation title, or the reading row
  // held by an idle prepend. Either releases before the next user gesture.
  useLayoutEffect(() => {
    const anchor = titleAnchorRef.current;
    const held = heldRef.current;
    if ((!anchor && !held) || !stream) return;
    const i = anchor
      ? sectionStarts.get(anchor.section)
      : rowIndex.get(held!.key);
    if (i === undefined) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `:scope > li[data-index="${i}"]`,
    );
    const start = virtualizer.measurementsCache[i]?.start;
    const target = anchor
      ? (headerRef.current?.getBoundingClientRect().bottom ?? headerHeight)
      : held!.top;
    const delta = el
      ? el.getBoundingClientRect().top - target
      : start === undefined
        ? 0
        : start - window.scrollY - target;
    if (Math.abs(delta) >= 1)
      window.scrollBy({ top: delta, behavior: "instant" });
    if (held) held.scrollY = window.scrollY;
    if (anchor?.focusKey) {
      const focus = refs.get(anchor.focusKey);
      if (focus) {
        focus.focus({ preventScroll: true });
        placeCaretAtEnd(focus);
        anchor.focusKey = undefined;
      }
    }
  });

  // Publish the section in view, load at the edges, and settle a scroll
  // gesture that ends near a section start onto it (proximity snapping).
  useEffect(() => {
    if (!stream) {
      setStreamView(null);
      return;
    }
    const publish = () => {
      const inView = sectionInView();
      if (inView) setStreamView({ anchor: stream.anchor, inView });
    };
    let gesture = false;
    let touching = false;
    let pointing = false;
    let settle = 0;
    stopSnapRef.current = () => {
      gesture = false;
      touching = false;
      pointing = false;
      deferPrependRef.current = false;
      window.clearTimeout(settle);
    };
    const markGesture = () => {
      releaseTitle();
      gesture = true;
      // The user scrolling ends a `?day=` restore: the URL follows them now.
      restoringDayRef.current = null;
    };
    const snap = () => {
      if (!gesture || titleAnchorRef.current) return;
      gesture = false;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const cache = virtualizer.measurementsCache;
      const line = window.scrollY + headerHeightRef.current;
      let nearest: number | null = null;
      for (const i of sectionStartsRef.current.values()) {
        const m = cache[i];
        if (!m) continue;
        const d = m.start - line;
        if (nearest === null || Math.abs(d) < Math.abs(nearest)) nearest = d;
      }
      const limit = Math.min(160, window.innerHeight * 0.2);
      if (
        nearest === null ||
        Math.abs(nearest) < 2 ||
        Math.abs(nearest) > limit
      )
        return;
      // A smooth snap can cross the load threshold too. Let it settle before
      // inserting rows, rather than compensating against its moving target.
      heldRef.current = null;
      deferPrependRef.current = true;
      window.scrollTo({
        top: window.scrollY + nearest,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    };
    const onSettled = () => {
      if (touching || pointing) return;
      deferPrependRef.current = false;
      maybeExtend();
      // The insertion's compensating scroll schedules the eventual snap.
      if (!extendingRef.current) snap();
    };
    const onScroll = () => {
      // A scrollbar drag or keyboard scroll can continue without another
      // pointer/key event. Release a reading hold, but keep a dispatched
      // prepend's compensation relative to the newly revealed position.
      const held = heldRef.current;
      if (held) {
        const moved = window.scrollY - held.scrollY;
        if (Math.abs(moved) >= 1) {
          if (extendingRef.current) {
            held.top -= moved;
            held.scrollY = window.scrollY;
          } else heldRef.current = null;
        }
      }
      deferPrependRef.current = true;
      publish();
      maybeExtend();
      window.clearTimeout(settle);
      settle = window.setTimeout(onSettled, 180);
    };
    const onTouchStart = () => {
      touching = true;
      heldRef.current = null;
      deferPrependRef.current = true;
      window.clearTimeout(settle);
    };
    const onTouchEnd = () => {
      touching = false;
      window.clearTimeout(settle);
      settle = window.setTimeout(onSettled, 180);
    };
    const onEdit = (e: Event) => {
      if (!(e.target instanceof HTMLElement && e.target.isContentEditable))
        return;
      if (!releaseTitle()) return;
      // Today can focus a last child far below its title. WebKit does not
      // always reveal it on input-only edits, so hand off to the caret once.
      const { y } = caretPosition(e.target);
      const viewport = window.visualViewport;
      const top =
        (viewport?.offsetTop ?? 0) +
        (parseFloat(getComputedStyle(e.target).lineHeight) || 24) +
        8;
      const bar = document.querySelector("[data-mobile-bar]");
      const barRect = bar?.getBoundingClientRect();
      const viewportBottom =
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
      // A viewport shrink can beat the toolbar's React commit. Reserve its
      // bottom inset in the live viewport, not in its still-tall fixed frame.
      const frameBottom = bar?.parentElement?.getBoundingClientRect().bottom;
      const frameOverflow =
        (viewport?.scale ?? 1) > 1
          ? 0 // The toolbar deliberately does not follow pinch zoom.
          : Math.max(0, (frameBottom ?? viewportBottom) - viewportBottom);
      const bottom =
        Math.min(
          viewportBottom,
          barRect?.height ? barRect.top - frameOverflow : Infinity,
        ) - 8;
      const delta = y < top || y > bottom ? y - (top + bottom) / 2 : 0;
      if (!delta) return;
      const from = window.scrollY;
      window.scrollBy({ top: delta, behavior: "instant" });
      // Keep a hold on the revealed caret, not where the title left it.
      const held = heldRef.current;
      if (held) {
        held.top -= window.scrollY - from;
        held.scrollY = window.scrollY;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      onEdit(e);
      releaseTitle();
      if (
        ["PageUp", "PageDown", "Home", "End", " "].includes(e.key) &&
        !(e.target instanceof HTMLElement && e.target.isContentEditable)
      )
        gesture = true;
    };
    publish();
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("wheel", markGesture, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", markGesture, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    window.addEventListener("keydown", onKey, true);
    // Do not move a sticky control out from under the finger before its click.
    const onPointer = (e: PointerEvent) => {
      pointing = true;
      deferPrependRef.current = true;
      window.clearTimeout(settle);
      if (
        !(e.target instanceof Element && headerRef.current?.contains(e.target))
      )
        releaseTitle();
    };
    const onPointerEnd = () => {
      pointing = false;
      window.clearTimeout(settle);
      settle = window.setTimeout(onSettled, 180);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    window.addEventListener("click", releaseTitle, true);
    for (const event of ["beforeinput", "compositionstart", "input"])
      window.addEventListener(event, onEdit, true);
    return () => {
      stopSnapRef.current = null;
      deferPrependRef.current = false;
      window.clearTimeout(settle);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("wheel", markGesture);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", markGesture);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      window.removeEventListener("click", releaseTitle, true);
      for (const event of ["beforeinput", "compositionstart", "input"])
        window.removeEventListener(event, onEdit, true);
      setStreamView(null);
    };
  }, [stream, virtualizer, sectionInView, maybeExtend, releaseTitle]);
  // The list changing under a still viewport (a section created, a fold
  // opened) can change the section in view too.
  useEffect(() => {
    if (!stream) return;
    const inView = sectionInView();
    if (inView) setStreamView({ anchor: stream.anchor, inView });
  }, [stream, items, sectionInView]);

  // The URL follows the section in view with a replace, so a reload or a
  // shared link returns to it. Only the search param changes: the route's
  // zoom root, and every effect keyed on it, stays put.
  useEffect(() => {
    if (!stream || !inViewSection) return;
    // A `?day=` restore ends once its day is in view. Until then the URL keeps
    // it, so the anchor showing first does not erase the link's destination.
    const restoring = restoringDayRef.current;
    if (restoring !== null) {
      if (inViewSection !== restoring) return;
      restoringDayRef.current = null;
    }
    const day = inViewSection === stream.anchor ? undefined : inViewSection;
    if (routeSearch.day === day) return;
    const timer = window.setTimeout(() => {
      void navigate({
        to: ".",
        search: (prev: OutlineSearch) => ({ ...prev, day }),
        replace: true,
        resetScroll: false,
        state: (prev) => prev,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [stream, inViewSection, routeSearch.day, navigate]);

  // Bridges for event-time callers: the strip and Today scroll the stream;
  // the caret walk follows the list across sections.
  useLayoutEffect(() => {
    if (!stream) return;
    setStreamScroller(jumpToSection);
    setStreamNeighbor((key, direction) => {
      const list = itemsRef.current;
      const from = rowIndexRef.current.get(key);
      if (from === undefined) return null;
      const step = direction === "up" ? -1 : 1;
      for (let i = from + step; i >= 0 && i < list.length; i += step) {
        const item = list[i]!;
        if (
          (item.kind === "row" || item.kind === "title") &&
          rowIndexRef.current.has(item.key)
        )
          return item.key;
      }
      return null;
    });
    return () => {
      setStreamScroller(null);
      setStreamNeighbor(null);
    };
  }, [stream, jumpToSection]);

  // All write-intent route entries (Today, /today, command search) use the
  // same title-first jump as the header inside an existing stream.
  // Nodes can arrive before the stream's mapping on a cold load. Let stream
  // adoption replace that ordinary landing, including its offscreen focus.
  // Wait for presentation to index the rows before consuming the one-shot
  // landing: the sync snapshot can arrive after the editor has mounted empty.
  const landedLastRef = useRef<"outline" | "stream" | null>(null);
  useEffect(() => {
    if (
      landedLastRef.current === "stream" ||
      (!stream && landedLastRef.current === "outline") ||
      pivotId ||
      !focusLast ||
      !rootId ||
      loading ||
      !presentationReady
    )
      return;
    const children = childrenOf(getTreeIndex(), rootId).filter(
      (n) => !isHidden(n),
    );
    const lastChild = children[children.length - 1];
    if (!lastChild) return;
    landedLastRef.current = stream ? "stream" : "outline";
    if (stream) {
      pendingFocus.current = null;
      jumpToSection(routeSearchDayRef.current ?? stream.anchor, lastChild.id);
      return;
    }
    const el = refs.get(lastChild.id);
    if (!el) {
      if (scrollRowIntoView(lastChild.id)) pendingFocus.current = lastChild.id;
      return;
    }
    el.focus({ preventScroll: true });
    placeCaretAtEnd(el);
    el.scrollIntoView({ block: "nearest" });
  }, [
    stream,
    loading,
    presentationReady,
    rootId,
    focusLast,
    pivotId,
    isHidden,
    refs,
    pendingFocus,
    jumpToSection,
  ]);

  // Without a stream (a filter, or the option off) commands target the zoom
  // root again: a section override left behind would aim them at another day.
  useEffect(() => {
    if (!stream) setViewSectionRoot(null);
  }, [stream]);

  /** Point commands at the section an element belongs to, and keep that
   *  section visible while it is being worked in. */
  const activateSectionAt = (target: EventTarget | null) => {
    if (!stream || !(target instanceof Element)) return;
    const li = target.closest<HTMLElement>("li[data-index]");
    const item = li ? itemsRef.current[Number(li.dataset.index)] : undefined;
    if (!item || item.kind === "fold") return;
    const section =
      item.kind === "row"
        ? snapshotRef.current.rowSection.get(item.key)
        : item.section;
    if (!section) return;
    setViewSectionRoot(stream.resolve(section));
    if (stream.emptyMode !== "show" && !expanded.has(section))
      setExpanded((prev) => new Set(prev).add(section));
  };

  // First keystroke in an empty section starts it (ADR 0070 decision 3): a
  // section with a node gains its first child; one without is created with
  // its seeded entry line. The typed text moves into the new row, and the
  // caret follows it.
  const writingRef = useRef(new Set<string>());
  // Typing holds still waiting on a day's creation; unmount cancels them.
  const holdsRef = useRef(new Set<() => void>());
  useEffect(() => {
    const holds = holdsRef.current;
    return () => {
      for (const cancel of holds) cancel();
      holds.clear();
    };
  }, []);
  const writeIntoSection = useCallback(
    (section: string, el: HTMLElement) => {
      if (!stream || writingRef.current.has(section)) return;
      writingRef.current.add(section);
      // Creation is async, and the entry line unmounts as soon as the day exists,
      // which drops focus to the body. Hold characters typed while focus is
      // nowhere, so a fast typist loses nothing. The hold belongs to this one
      // editing interaction: a click, or focus landing anywhere else, ends it
      // and leaves the caret where the user put it.
      let held = "";
      let holding = true;
      const hold = (e: KeyboardEvent) => {
        const active = document.activeElement;
        if (active === el) return;
        if (active && active !== document.body) return endHold();
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        held += e.key;
      };
      const onFocusIn = (e: FocusEvent) => {
        if (e.target !== el) endHold();
      };
      const endHold = () => {
        if (!holding) return;
        holding = false;
        document.removeEventListener("keydown", hold, true);
        document.removeEventListener("pointerdown", endHold, true);
        document.removeEventListener("focusin", onFocusIn, true);
        holdsRef.current.delete(endHold);
      };
      document.addEventListener("keydown", hold, true);
      document.addEventListener("pointerdown", endHold, true);
      document.addEventListener("focusin", onFocusIn, true);
      holdsRef.current.add(endHold);
      const release = () => {
        // Read before ending: an ended hold means the user moved on.
        const kept = holding;
        endHold();
        writingRef.current.delete(section);
        return kept;
      };
      const finish = (entryId: string) => {
        const keepCaret = release();
        const text = (el.textContent ?? "") + held;
        setViewSectionRoot(stream.resolve(section));
        setExpanded((prev) =>
          prev.has(section) ? prev : new Set(prev).add(section),
        );
        const mounted = refs.get(entryId);
        // A seeded entry row is already mounted and empty: fill its DOM before
        // the store write, so the sync effect keeps the caret at the end.
        if (mounted && mounted !== document.activeElement)
          mounted.textContent = text;
        if (keepCaret) {
          commands.setPendingFocus(entryId, text.length);
          if (mounted) {
            mounted.focus();
            applyPendingCaret(mounted, entryId, false);
            pendingFocus.current = null;
          }
        }
        if (text) commands.onTextChange(entryId, text);
      };
      const existing = stream.resolve(section);
      if (existing && getTreeIndex().byId.has(existing)) {
        const entryId = runStructural(() => {
          capture(getTreeIndex(), existing, null, { label: "create" });
          return insertChildAtStart(getTreeIndex(), existing);
        });
        finish(entryId);
        return;
      }
      void stream.create(section).then((created) => {
        if (created) finish(created.entryId);
        else release();
      });
    },
    [stream, commands, refs, pendingFocus],
  );

  const renderStreamItem = (
    item: Exclude<ListItem, { kind: "row" }>,
    index: number,
    start: number,
  ) => {
    if (!stream) return null;
    const shell = {
      index,
      start,
      scrollMargin: virtualizer.options.scrollMargin,
      measureRef: virtualizer.measureElement,
    };
    if (item.kind === "fold") {
      return (
        <StreamShell
          key={item.key}
          kind="fold"
          section={item.sections[0]!}
          {...shell}
        >
          <StreamFold
            label={stream.foldLabel(item.sections)}
            onExpand={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                for (const key of item.sections) next.add(key);
                return next;
              })
            }
          />
        </StreamShell>
      );
    }
    if (item.kind === "placeholder") {
      return (
        <StreamShell
          key={item.key}
          kind="placeholder"
          section={item.section}
          {...shell}
        >
          <StreamPlaceholderTitle stream={stream} section={item.section} />
          <StreamEntryLine section={item.section} onWrite={writeIntoSection} />
        </StreamShell>
      );
    }
    if (item.kind === "end") {
      // Top the section up to one screen, minus a peek of the next title.
      const first = sectionStarts.get(item.section);
      const cache = virtualizer.measurementsCache;
      const from = first === undefined ? undefined : cache[first];
      const to = cache[index];
      const pad =
        from && to
          ? Math.max(0, Math.round(streamPage - (to.start - from.start)))
          : 0;
      return (
        <StreamShell
          key={item.key}
          kind="end"
          section={item.section}
          height={pad}
          {...shell}
        >
          {item.emptyNodeId ? (
            <StreamEntryLine
              section={item.section}
              onWrite={writeIntoSection}
            />
          ) : null}
        </StreamShell>
      );
    }
    return (
      <StreamShell
        key={item.key}
        kind="title"
        section={item.section}
        {...shell}
      >
        <StreamSectionTitle
          nodeId={item.nodeId}
          isPivot={pivotId === item.nodeId}
          registerRef={registerRef}
          getCtx={pluginCtx}
          commands={commands}
          pendingFocus={pendingFocus}
        />
      </StreamShell>
    );
  };

  // Deep-linked to a node that no longer exists (and the store has loaded).
  if (rootId !== null && zoomedNode === null && hasNodes) {
    return (
      <div className="mx-auto max-w-[720px] p-6 max-sm:px-4">
        <div className="outline-empty">
          That bullet doesn't exist. <Link to="/">Back to top</Link>.
        </div>
      </div>
    );
  }

  return (
    <>
      <FocusPass
        ready={presentationReady}
        refs={refs}
        pendingFocus={pendingFocus}
        pendingFocusAtStart={pendingFocusAtStart}
        pendingFlash={pendingFlash}
      />
      <SelectionActionsMenu ops={selection.ops} getCtx={pluginCtx} />
      <div
        className="outline-chrome relative sticky top-0 z-10"
        ref={headerRef}
      >
        <Header getCtx={pluginCtx}>
          <BreadcrumbTrail
            trail={trail}
            rootId={trailRoot || null}
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
        className={
          spotlight
            ? "mx-auto mb-[50vh] max-w-180 p-6 pt-[50vh] max-sm:p-4 max-sm:pt-[50vh]"
            : "mx-auto mb-[50vh] max-w-180 p-6 max-sm:p-4"
        }
        onMouseDown={onContentMouseDown}
        onPointerDown={onContentPointerDown}
        onPointerUp={onContentPointerUp}
        onPointerCancel={onContentPointerCancel}
        onClick={onContentClick}
        onKeyDown={onContentKeyDown}
        onContextMenu={onContentContextMenu}
        onPointerDownCapture={(event) => {
          pointerFocus.current = true;
          activateSectionAt(event.target);
        }}
        onPointerCancelCapture={() => {
          pointerFocus.current = false;
        }}
        onClickCapture={() => {
          // Dead-space taps focus text during click, after pointerup. Clear
          // after dispatch so those taps preserve the view too.
          queueMicrotask(() => {
            pointerFocus.current = false;
          });
        }}
        onKeyDownCapture={() => {
          pointerFocus.current = false;
        }}
        onFocus={(event) => {
          activateSectionAt(event.target);
          setFocusedFilterKey(findFocusedId());
          if (
            !pointerFocus.current &&
            event.target instanceof HTMLElement &&
            event.target.classList.contains("node-text")
          )
            revealOutlineRow(event.target);
        }}
        onBlur={(event) => {
          // Portaled row menus sit outside this region in the DOM. Keep the
          // focused-row subscription while focus is in one, or this state
          // change would detach the menu before its click lands.
          const next = event.relatedTarget;
          if (
            next instanceof HTMLElement &&
            next.closest('[data-slot="dropdown-menu-content"]')
          )
            return;
          // Base UI can move focus after blur dispatch, leaving relatedTarget
          // null. Wait through the pointer event's default focus transfer before
          // deciding the row is truly unfocused.
          window.setTimeout(() => {
            if (
              document.activeElement instanceof HTMLElement &&
              document.activeElement.closest(
                '[data-slot="dropdown-menu-content"]',
              )
            )
              return;
            setFocusedFilterKey(null);
          }, 0);
        }}
      >
        {/* Mobile-only keyboard-anchored action strip. Mounts only on a coarse
            pointer and only while a bullet is focused (both gated inside the
            component), so on desktop this renders nothing. ADR 0030. */}
        <MobileActionsBar
          actions={mobileBarActions}
          formatActions={selectionFormatActions}
          findFocusedId={findFocusedId}
        />

        {/* Desktop-only formatting toolbar over a text selection (ADR 0036).
            Gates itself on a fine pointer + a single-span selection, so it
            renders nothing on touch or when nothing is selected. */}
        <SelectionFormatToolbar actions={selectionFormatActions} />

        {overlayNode}

        {/* Tier-3 side panel host (ADR 0031). A plugin (or the node-decoration
            overflow affordance) opens rich, contained UI here via ctx.openPanel;
            the Sheet owns the backdrop + dismiss so it can't crowd the outline. */}
        <Sheet
          open={panelNode != null}
          onOpenChange={(open) => {
            if (!open) setPanelNode(null);
          }}
        >
          <SheetContent side="right">{panelNode}</SheetContent>
        </Sheet>

        {loading ? (
          <OutlineLoading />
        ) : (
          <div className={revealOnLoad ? "outline-reveal" : undefined}>
            {zoomedNode && !stream && (
              <>
                <ZoomedTitle
                  node={zoomedNode}
                  isPivot={pivotId === zoomedNode.id}
                  registerRef={registerRef}
                  getCtx={pluginCtx}
                  setPendingFocus={commands.setPendingFocus}
                  onTextChange={(text) =>
                    commands.onTextChange(zoomedNode.id, text)
                  }
                  onAddChild={() =>
                    runStructural(() => {
                      capture(getTreeIndex(), zoomedNode.id, null, {
                        label: "create",
                      });
                      const newId = insertChildAtStart(
                        getTreeIndex(),
                        zoomedNode.id,
                      );
                      pendingFocus.current = newId;
                    })
                  }
                  onArrowDown={() =>
                    commands.onMoveFocus(zoomedNode.id, "down")
                  }
                />
                {/* "{n} backlinks" under the title (ADR 0032) -- core chrome in
                    the mirror-badge family; renders nothing at zero. */}
                <Backlinks nodeId={zoomedNode.id} />
              </>
            )}

            {noMatches && renderedRows.length === 0 && filter?.emptyMessage ? (
              <div className="outline-empty">{filter.emptyMessage}</div>
            ) : (
              <div
                ref={canvasViewportRef}
                className="outline-canvas-viewport scroll-fade-x"
              >
                <div
                  className="outline-canvas"
                  style={{
                    width: `max(100%, calc(${deepestVisibleDepth * INDENT_PX}px + var(--outline-node-min-width)))`,
                  }}
                >
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
                    {virtualItems.map((vi) => {
                      const item = items[vi.index];
                      if (!item) return null;
                      if (item.kind !== "row")
                        return renderStreamItem(item, vi.index, vi.start);
                      const row = item.row;
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
                          ancestorCompleted={row.ancestorCompleted}
                          exiting={presentation.exiting.has(row.key)}
                          exitInert={
                            presentation.exiting.get(row.key)?.fading ?? false
                          }
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
                  {/* Click in the whitespace below the list adds a new top-level
                bullet. Hidden while filtering -- there's no "add here" then.
                `size="icon"` (32px) is what puts the glyph on the same vertical
                axis as the bullets above and the breadcrumb Home button. */}
                  {!filter && !stream && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Add node"
                      data-outline-add=""
                      onClick={() =>
                        runStructural(() => {
                          capture(getTreeIndex(), null, null, {
                            label: "create",
                          });
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
                </div>
              </div>
            )}
          </div>
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
    // Kick every plugin's eager data fetch (the daily index) before the outline
    // snapshot lands, so async decorations resolve by first paint instead of
    // popping in after it. Client-only and post-auth here by construction.
    for (const preload of pluginPreloads) preload();
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
   *  distinct spans (ADR 0022); key === id for every mirror-free row, so titles
   *  and list items still register uniformly (the zoomed title registers under
   *  rootId, which is its own key). */
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
  // OutlineRow, so it MUST stay referentially stable (ADR 0014).
  const registerRef = useCallback(
    (id: string, el: HTMLSpanElement | null) => {
      if (el) refs.set(id, el);
      else refs.delete(id);
    },
    [refs],
  );

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
  // undo/redo replay a snapshot diff as a mix of insert/update/delete -- the
  // same multi-node relink a structural mutation does, so they ride the same
  // atomic batch (one frame, held until echo). runHistoryRestore picks the
  // apply path by diff size: small diffs stay synchronous (this must not regress
  // the keystroke-adjacent path); huge ones (undoing a 17k-node import/delete)
  // stream through runStructuralSliced behind a modal progress dialog.
  useHotkey(
    "Mod+Z",
    () =>
      runHistoryRestore("undo", findFocusedId(), (id) => {
        pendingFocus.current = id;
      }),
    { preventDefault: true },
  );
  useHotkey(
    "Mod+Shift+Z",
    () =>
      runHistoryRestore("redo", findFocusedId(), (id) => {
        pendingFocus.current = id;
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
  ready,
  refs,
  pendingFocus,
  pendingFocusAtStart,
  pendingFlash,
}: {
  ready: boolean;
  refs: Map<string, HTMLSpanElement | null>;
  pendingFocus: RefObject<string | null>;
  pendingFocusAtStart: RefObject<boolean>;
  pendingFlash: RefObject<string | null>;
}) {
  useTreeIndex();
  useEffect(() => {
    // Completion presentation reconciles in a layout effect. A structural
    // insert can reach this pass before its row is in the presentation list;
    // leave its pending focus/flash for the next commit and mount claim.
    if (!ready) return;
    const fid = pendingFocus.current;
    if (fid) {
      const el = refs.get(fid);
      if (el) {
        el.focus();
        applyPendingCaret(el, fid, pendingFocusAtStart.current);
        pendingFocus.current = null;
        pendingFocusAtStart.current = false;
      } else if (!scrollRowIntoView(fid)) {
        // Not windowed (or the id isn't a visible row): nothing to mount later,
        // so clear to avoid a stuck pending. When windowed and off-screen, leave
        // it set -- OutlineRow claims it in its mount effect once scrolled in.
        pendingFocus.current = null;
        pendingFocusAtStart.current = false;
        clearPendingCaretOffset();
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
 * the editor remounting per zoom view (its `key={nodeId}`; see
 * docs/architecture.md "`rootId` is route-owned").
 */
function useZoomNavigation({
  rootId,
  isHidden,
  refs,
  navigate,
  pendingFocus,
  pendingFlash,
}: ZoomNavigationArgs) {
  // The "pivot" of the last zoom: the node that swaps between title and list-
  // item roles. The incoming view reads it from history state and names that
  // node's element so the browser morphs it across the navigation.
  const location = useLocation();
  const pivotId = location.state.pivotId ?? null;
  const rowNavigation = useRef(pivotId !== null);
  const flashAfterNav = useRef<string | null>(null);
  useLayoutEffect(() => {
    flashAfterNav.current ??= consumeFlashAfterNav();
    if (flashAfterNav.current) rowNavigation.current = true;
  }, []);
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
      // Navigation changes the view root, never saved expansion state.
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
  //  - Zooming OUT: the node you came from, or its closest visible ancestor.
  // Then scroll the target into view if it landed below the fold. Mount-only by
  // design (the editor remounts per zoom view) and passive: each bullet's text
  // is written in OutlineRow's own passive effect, so only by now is the list
  // laid out at its real heights.
  useEffect(() => {
    if (!pivotId) return;
    const index = getTreeIndex();
    let targetId: string | null = pivotId;
    if (pivotId === rootId) {
      const firstChild = childrenOf(index, rootId).find((n) => !isHidden(n));
      if (firstChild) targetId = firstChild.id;
    }
    // A missing DOM ref can mean either off-screen or hidden. The virtualizer
    // knows which rows are visible: try scrolling before walking to a parent,
    // so an off-screen pivot keeps focus instead of handing it to an ancestor.
    let guard = index.byId.size + 1;
    while (targetId !== null && guard-- > 0) {
      const el = refs.get(targetId);
      if (el) {
        el.focus({ preventScroll: true });
        placeCaretAtEnd(el);
        el.scrollIntoView({ block: "nearest" });
        return;
      }
      if (scrollRowIntoView(targetId)) {
        pendingFocus.current = targetId;
        return;
      }
      // Only zoom-out walks ancestors, and never past the destination title.
      if (pivotId === rootId || targetId === rootId) return;
      targetId = index.byId.get(targetId)?.parentId ?? null;
    }
    // Mount-only by design: the editor remounts per zoom view (route key), so
    // the captured values are current at mount. Re-running on any of them would
    // re-steal focus mid-edit -- not a staleness bug.
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, []);

  // /move's "Go" jumps to the destination's zoom view and asks us to focus and
  // flash the moved node so it's easy to spot. Mount-only/passive, like above.
  useEffect(() => {
    const flashId = flashAfterNav.current;
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

  return { navigateZoom, pivotId, rowNavigation };
}

/**
 * Facade for the mobile actions bar (ADR 0030): the existing per-bullet commands
 * (+ undo/redo) re-exposed as zero-arg methods, each resolving the focused bullet
 * through `findFocusedId()`. The bar's buttons preventDefault on pointerdown so
 * the contentEditable stays focused, which guarantees `findFocusedId()` is
 * non-null at call time. It adds no new mutation path: indent/outdent/complete
 * route through `commands` (inheriting runStructural + protection guards), and
 * undo/redo mirror the useOutlineFocus hotkeys verbatim. Stable identity so the
 * bar's props never change on a keystroke.
 */
function useMobileBarActions({
  refs,
  findFocusedId,
  pendingFocus,
  commands,
}: {
  refs: Map<string, HTMLSpanElement | null>;
  findFocusedId: () => string | null;
  pendingFocus: RefObject<string | null>;
  commands: NodeCommands;
}): MobileBarActions {
  return useMemo<MobileBarActions>(() => {
    const focusedEl = (): HTMLSpanElement | null => {
      const key = findFocusedId();
      return key ? (refs.get(key) ?? null) : null;
    };
    return {
      // onIndent/onOutdent re-resolve findFocusedId() internally; passing the key
      // is belt-and-suspenders (and a no-op guard when focus is somehow gone).
      indent: () => {
        const key = findFocusedId();
        if (key) commands.onIndent(key);
      },
      outdent: () => {
        const key = findFocusedId();
        if (key) commands.onOutdent(key);
      },
      // Verbatim twins of the Mod+Z / Mod+Shift+Z hotkeys in useOutlineFocus.
      undo: () =>
        runHistoryRestore("undo", findFocusedId(), (id) => {
          pendingFocus.current = id;
        }),
      redo: () =>
        runHistoryRestore("redo", findFocusedId(), (id) => {
          pendingFocus.current = id;
        }),
      // Flip completion relative to the CONTENT node's current state (mirror-aware,
      // like onDeleteNode); onToggleCompleted enforces the protected-node guard.
      toggleComplete: () => {
        const key = findFocusedId();
        if (!key) return;
        const idx = getTreeIndex();
        const instanceId = instanceIdForKey(key);
        const contentId = isMirrorsEnabled()
          ? (idx.byId.get(instanceId)?.mirrorOf ?? instanceId)
          : instanceId;
        const node = idx.byId.get(contentId);
        if (!node) return;
        commands.onToggleCompleted(contentId, !node.completed);
      },
      // Simulate the "/" keystroke so the row's own detectSlash opens the palette.
      // execCommand fires a native input event, which the row's onInput handler
      // (text sync + slash detection) reads via readSource — don't hand-splice DOM.
      insertSlash: () => {
        if (!focusedEl()) return;
        document.execCommand("insertText", false, "/");
      },
    };
  }, [refs, findFocusedId, pendingFocus, commands]);
}

/**
 * Zero-arg command surface for the desktop selection formatting toolbar (ADR
 * 0036), the fine-pointer twin of useMobileBarActions. Resolves the focused
 * (mirror-aware) content node internally and routes into the SAME
 * emphasis/highlight/link paths the keyboard uses — no new mutation path. The
 * link action reuses the links plugin's `/link` CommandSpec, so it's absent when
 * that plugin isn't loaded. Stable identity.
 */
function useSelectionFormatActions({
  findFocusedId,
  commands,
  getCtx,
}: {
  findFocusedId: () => string | null;
  commands: NodeCommands;
  getCtx: () => PluginContext;
}): SelectionFormatActions {
  return useMemo<SelectionFormatActions>(() => {
    // The focused span's CONTENT node id (mirror row -> its source), the id the
    // source text lives under — same resolution as the mobile bar's toggleComplete.
    const contentId = (): string | null => {
      const key = findFocusedId();
      if (!key) return null;
      const instanceId = instanceIdForKey(key);
      return isMirrorsEnabled()
        ? (getTreeIndex().byId.get(instanceId)?.mirrorOf ?? instanceId)
        : instanceId;
    };
    const linkSpec = commandSpecs.find((c) => c.id === "link") ?? null;
    return {
      toggleMarker: (marker: MarkerPair) => {
        const id = contentId();
        // reselect = true: keep the interior selected so the button stays lit and
        // a re-press toggles off (the toolbar's whole point).
        if (id) toggleWrapSelection(id, marker, commands.onTextChange, true);
      },
      toggleHighlight: () => {
        const id = contentId();
        if (id) toggleHighlightSelection(id, commands.onTextChange);
      },
      createLink: linkSpec
        ? () => {
            const id = contentId();
            if (id) linkSpec.run(id, getCtx());
          }
        : null,
    };
  }, [findFocusedId, commands, getCtx]);
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
 * The per-bullet command set, handed to every OutlineRow. Stable identity
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
  return useMemo<NodeCommands>(
    () => {
      // The `.outline-row` element for a node, for the protection-rejection shake.
      const rowOf = (id: string) =>
        refs.get(id)?.closest(".outline-row") ?? null;
      return {
        onTextChange: (id, text) => {
          const idx = getTreeIndex();
          if (guardLocked(idx, id, rowOf(findFocusedId() ?? id))) return;
          if (idx.byId.get(id)?.text === text) return;
          captureTextHistory(id);
          setText(id, text);
        },

        onEnter: (id, caretOffset) => {
          const initialIndex = getTreeIndex();
          if (guardLocked(initialIndex, id, rowOf(findFocusedId() ?? id)))
            return;
          // The new node's id + the row the user was editing, returned from the
          // batch so the focus key can be re-derived from the post-edit render walk
          // AFTER it commits (focusKeyFor reads the settled collection).
          const plan = runStructural(
            (): {
              instanceId: string;
              activeKey: string;
              atStart: boolean;
            } | null => {
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
              capture(idx, activeKey, null, { label: "create" });
              const offset = Math.max(
                0,
                Math.min(caretOffset, content.text.length),
              );
              const before = content.text.slice(0, offset);
              const after = content.text.slice(offset);
              // Caret at the very START of a bullet that HAS text: this is not a
              // split, it's "make room above". The edited node keeps its id, its
              // text, and its children -- only an empty sibling appears before it.
              // (Splitting here would blank this node and hand its text to a NEW
              // one below, orphaning its children under the blank line and moving
              // identity out from under every bookmark / [[link]] / mirror / daily
              // mapping pointing at it.) Checked BEFORE the mirror redirect: this
              // arm writes nothing to the source and positions the new node beside
              // the INSTANCE, which is the local-position side (ADR 0022).
              if (offset === 0 && content.text.length > 0) {
                // Insert BEFORE = insert after our own predecessor. At the head
                // that's null, which insertSibling handles by repointing the old
                // head -- so one call covers head and middle alike.
                insertSibling(
                  idx,
                  instance.parentId,
                  instance.prevSiblingId,
                  content.isTask,
                  "",
                  content.kind,
                );
                // Focus stays on the row the user was editing, caret still at its
                // start -- the blank line is above, ready to arrow up into. (A
                // deliberate divergence from Workflowy, which parks the caret in
                // the new line: every other arm only moves the caret when it moved
                // the text.) Still routed through pendingFocus because the row
                // shifts position in the flat windowed list (ADR 0019).
                return { instanceId, activeKey, atStart: true };
              }
              // On a mirror's OWN row, Enter never moves text off the source -- the
              // text is the source's content, so a split would either desync every
              // instance or strand the tail on a local node. Treat it as the empty-
              // tail case: add a node, leave the source text whole (ADR 0022, 2c).
              const caretAtEnd =
                isMirrorRow || content.kind === "embed" || after.length === 0;
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
                newId = insertChildAtStart(
                  idx,
                  contentId,
                  content.isTask,
                  "",
                  undefined,
                  content.kind,
                );
              } else if (!caretAtEnd) {
                // Mid-split: one atomic Lunora mutator (or insertSibling+setText
                // inside this runStructural batch on the custom-DO path).
                // Mirror rows force caretAtEnd above, so this arm is never a mirror.
                newId = splitNode(idx, {
                  nodeId: contentId,
                  parentId: instance.parentId,
                  afterId: instanceId,
                  leftText: before,
                  rightText: after,
                  isTask: content.isTask,
                  kind: content.kind,
                });
                atStart = true;
              } else {
                // New sibling beside the INSTANCE (position is local to where the row
                // sits). Off-flag / mirror-free, instance === content === id, so this
                // is byte-identical to the old new-sibling path.
                newId = insertSibling(
                  idx,
                  instance.parentId,
                  instanceId,
                  content.isTask,
                  "",
                  content.kind,
                );
              }
              return { instanceId: newId, activeKey, atStart };
            },
          );
          if (plan) {
            pendingFocus.current = focusKeyFor(plan.instanceId, plan.activeKey);
            pendingFocusAtStart.current = plan.atStart;
          }
        },

        onIndent: (id) => {
          const plan = runStructural(
            (): { instanceId: string; activeKey: string } | null => {
              // Indent reorders the INSTANCE (position is local, ADR 0022). Inside a
              // mirror the windowed children are real source nodes, so this restructures
              // the source and shows in every instance; on a mirror's own row it moves
              // that mirror, not the source. Address by the focused row's key (the
              // keymap passes the content id inside a mirror).
              const activeKey = findFocusedId() ?? id;
              const instanceId = instanceIdForKey(activeKey);
              // Moving the node reparents it, which drops focus. Re-focus after render.
              capture(getTreeIndex(), activeKey, null, { label: "indent" });
              if (indent(getTreeIndex(), instanceId, isMirrorsEnabled()))
                return { instanceId, activeKey };
              drop(); // no move happened; discard the redundant undo point
              return null;
            },
          );
          if (plan) {
            const key = focusKeyFor(plan.instanceId, plan.activeKey);
            pendingFocus.current = key;
            pendingFlash.current = key;
          }
        },

        onOutdent: (id) => {
          const plan = runStructural(
            (): { instanceId: string; activeKey: string } | null => {
              const activeKey = findFocusedId() ?? id;
              const instanceId = instanceIdForKey(activeKey);
              // Don't let a direct child of the zoom root outdent past it; that
              // would move it out of the visible subtree and look like it vanished.
              const node = getTreeIndex().byId.get(instanceId);
              if (node && node.parentId === getViewRootId()) return null;
              // Same remount-drops-focus issue as indent; re-focus on a real move.
              capture(getTreeIndex(), activeKey, null, { label: "outdent" });
              if (outdent(getTreeIndex(), instanceId))
                return { instanceId, activeKey };
              drop();
              return null;
            },
          );
          if (plan) {
            const key = focusKeyFor(plan.instanceId, plan.activeKey);
            pendingFocus.current = key;
            pendingFlash.current = key;
          }
        },

        onMoveUp: (id) => {
          const plan = runStructural(
            (): { instanceId: string; activeKey: string } | null => {
              // Move reorders the INSTANCE (position is local, ADR 0022); address by
              // the focused key so a mirror moves itself, not its source.
              const activeKey = findFocusedId() ?? id;
              const instanceId = instanceIdForKey(activeKey);
              // Reorder/outdent remounts the contentEditable; re-focus on a real move.
              capture(getTreeIndex(), activeKey, null, { label: "move" });
              const moved = moveUp(getTreeIndex(), instanceId, {
                isVisible: (n) => !getViewIsHidden()(n),
                rootId: getViewRootId(),
                resolveMirror: isMirrorsEnabled(),
              });
              if (moved) return { instanceId, activeKey };
              drop();
              return null;
            },
          );
          if (plan) {
            const key = focusKeyFor(plan.instanceId, plan.activeKey);
            pendingFocus.current = key;
            pendingFlash.current = key;
            // Spotlight (ADR 0060): a move-up reuses the DOM span, so focus
            // never leaves and the focusin centering never fires. Center the
            // moved row explicitly, two frames out.
            centerAfterMutation(() => refs.get(key) ?? null);
          }
        },

        onMoveDown: (id) => {
          const plan = runStructural(
            (): { instanceId: string; activeKey: string } | null => {
              const activeKey = findFocusedId() ?? id;
              const instanceId = instanceIdForKey(activeKey);
              capture(getTreeIndex(), activeKey, null, { label: "move" });
              const moved = moveDown(getTreeIndex(), instanceId, {
                isVisible: (n) => !getViewIsHidden()(n),
                rootId: getViewRootId(),
                resolveMirror: isMirrorsEnabled(),
              });
              if (moved) return { instanceId, activeKey };
              drop();
              return null;
            },
          );
          if (plan) {
            const key = focusKeyFor(plan.instanceId, plan.activeKey);
            pendingFocus.current = key;
            pendingFlash.current = key;
            // Mirror of onMoveUp: focusin usually covers a move-down (the row
            // remounts), but explicit centering keeps the two symmetric.
            centerAfterMutation(() => refs.get(key) ?? null);
          }
        },

        onDeleteNode: (id) => {
          // Delete the INSTANCE (position is local, ADR 0022): backspacing a
          // mirror's own row removes that mirror, never its source (which would
          // strand the other instances -- promote-on-source-delete is Stage 3).
          // Prefer the explicit target when it names a live node (Cmd+K / slash
          // bind the id). Only fall back to focus when the caller passed a
          // content id while a mirror INSTANCE holds focus (keymap).
          const idx = getTreeIndex();
          const focused = findFocusedId();
          const targetInstance = instanceIdForKey(id);
          const focusedInstance = focused ? instanceIdForKey(focused) : null;
          const activeKey =
            focused && focusedInstance === targetInstance
              ? focused
              : idx.byId.has(id)
                ? id
                : (focused ?? id);
          const instanceId = instanceIdForKey(activeKey);
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
          if (guardLockedDelete(idx, [instanceId], rowOf(activeKey))) return;
          // Deleting a SOURCE would orphan its live mirrors (Stage 3 promotes;
          // v1 blocks). A mirror's own row is never a source, so this no-ops
          // there -- backspacing a mirror still works. Flag-gated: off-flag a
          // mirrorOf node is just a normal node, so the guard never runs.
          if (
            mirrorsOn &&
            guardMirrorSourceDelete(idx, [instanceId], rowOf(activeKey))
          )
            return;
          // Big-subtree gate: deleting a threshold-plus subtree asks first, then
          // runs as the dialog's sliced progress flow (capture + plan + one
          // sliced batch happen there) -- the import-freeze lesson, inverted.
          const count = countSubtreeNodes(idx, [instanceId]);
          if (count >= DELETE_CONFIRM_THRESHOLD) {
            openDeleteConfirm({
              rootIds: [instanceId],
              count,
              captureKey: activeKey,
            });
            return;
          }
          runStructural(() => {
            capture(idx, activeKey, null, { label: "delete" });
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
              getViewFilter(),
              mirrorsOn,
            );
            const focusId = removeNode(idx, instanceId);
            const target = above ?? focusId;
            if (target) pendingFocus.current = target;
            else drop(); // node didn't exist; nothing was deleted
          });
        },

        onJoinPrevious: (id) => {
          // Backspace at the start of a bullet that has text: merge it into the
          // row visibly above -- the inverse of onEnter's mid-split. Same
          // id-resolution preamble as onDeleteNode (this is a delete of one node
          // plus a text edit of another), and the SAME guard funnel: a merge
          // must clear both ends.
          const idx = getTreeIndex();
          const focused = findFocusedId();
          const targetInstance = instanceIdForKey(id);
          const focusedInstance = focused ? instanceIdForKey(focused) : null;
          const activeKey =
            focused && focusedInstance === targetInstance
              ? focused
              : idx.byId.has(id)
                ? id
                : (focused ?? id);
          const instanceId = instanceIdForKey(activeKey);
          const mirrorsOn = isMirrorsEnabled();
          const contentId = mirrorsOn
            ? (idx.byId.get(instanceId)?.mirrorOf ?? instanceId)
            : instanceId;

          // Every eligibility rule -- has-children, mirror-row, the two-walk
          // hidden-between check, no-target -- is decided by the pure planner so
          // `bun test` can exercise the combinatorics (join-previous.ts).
          const plan = planJoinPrevious(
            idx,
            activeKey,
            getViewRootId(),
            getViewIsHidden(),
            getViewFilter(),
            mirrorsOn,
          );
          // A refusal is never silent: the row shakes, and where the reason
          // can't be seen on screen (a mirror row, something hidden between the
          // two rows) it also toasts. "Nothing happened" is the bug the ticket
          // reported -- a refused merge has to read as refused.
          if (plan.kind === "refuse") {
            signalJoinRefusal(plan.reason, rowOf(activeKey));
            return;
          }
          // Merging into a BLANK row above: the blank is what goes, and this
          // node is left completely untouched (id, text, children, caret). Same
          // result on screen as appending onto the blank, but identity stays on
          // the node carrying the text -- which is what makes Enter-at-start
          // (#326) followed by Backspace a true round trip. The guards flip with
          // the roles: the TARGET is the one being deleted, and nothing is
          // rewritten, so there is no blank-rule subject at all.
          if (plan.kind === "remove-empty-target") {
            if (guardLockedDelete(idx, [plan.targetId], rowOf(plan.targetKey)))
              return;
            if (
              guardProtected(
                plan.targetContentId,
                "delete",
                rowOf(plan.targetKey),
              )
            )
              return;
            if (
              mirrorsOn &&
              guardMirrorSourceDelete(
                idx,
                [plan.targetId],
                rowOf(plan.targetKey),
              )
            )
              return;
            runStructural(() => {
              capture(idx, activeKey, null, { label: "delete" });
              removeNode(idx, plan.targetId);
              // The row keeps its identity but SHIFTS in the flat windowed list,
              // so focus is re-claimed rather than assumed (ADR 0019) -- with the
              // caret put back where the user left it, at the start.
              setPendingCaretOffset(activeKey, 0);
              pendingFocus.current = activeKey;
            });
            return;
          }
          // The source disappears, so it's a delete...
          if (guardLockedDelete(idx, [instanceId], rowOf(activeKey))) return;
          if (guardLocked(idx, plan.targetContentId, rowOf(plan.targetKey)))
            return;
          if (guardProtected(contentId, "delete", rowOf(activeKey))) return;
          // ...and the target's text is rewritten, so it's a blank-rule subject.
          // Load-bearing, not defensive: without it a merge appends to a
          // protected node's canonical text and the blur heal silently reverts
          // it, losing the merged text outright.
          if (
            guardProtected(plan.targetContentId, "blank", rowOf(plan.targetKey))
          )
            return;
          if (
            mirrorsOn &&
            guardMirrorSourceDelete(idx, [instanceId], rowOf(activeKey))
          )
            return;

          const targetText = idx.byId.get(plan.targetContentId)?.text ?? "";
          runStructural(() => {
            capture(idx, activeKey, null, { label: "join" });
            joinIntoPrevious(idx, {
              targetContentId: plan.targetContentId,
              sourceInstanceId: instanceId,
              joinedText: targetText + plan.sourceText,
            });
            // The seam is neither the start nor the end of the target, so it
            // rides the one-shot offset carrier markdown paste already built
            // (ADR 0044) -- consumed by whichever claim site focuses the row.
            setPendingCaretOffset(plan.targetKey, plan.seamOffset);
            pendingFocus.current = plan.targetKey;
          });
        },

        onToggleCompleted: (id, completed) => {
          if (guardLocked(getTreeIndex(), id, rowOf(id))) return;
          // A protected node can't be marked done (completing it would strike
          // through its whole subtree). This funnel catches every completion path
          // (Mod+Enter / Mod+D on a bullet OR the zoomed title, the todos
          // checkbox). Un-marking (completed=false) is always allowed. See ADR 0015.
          if (completed && guardProtected(id, "complete", rowOf(id))) return;
          if (getTreeIndex().byId.get(id)?.completed === completed) return;
          capture(getTreeIndex(), id, null, { label: "completion" });
          toggleCompleted(id, completed);
        },

        onSetTask: (id, isTask) => {
          if (guardLocked(getTreeIndex(), id, rowOf(id))) return;
          // A protected node stays a plain text node -- it can't become a to-do.
          // This funnel catches every task-creation path (`/todo`, the `[]`
          // autoformat). Un-tasking (isTask=false) is always allowed. See ADR 0015.
          if (isTask && guardProtected(id, "task", rowOf(id))) return;
          const node = getTreeIndex().byId.get(id);
          if (node?.isTask === isTask && node.kind === null) return;
          capture(getTreeIndex(), id, null, { label: "kind" });
          setIsTask(id, isTask);
        },

        // `/paragraph`, and `/bullet`'s kind half (ADR 0045). A FIELD edit, like
        // onSetTask: one PATCH, no `runStructural`, no echo wait. No protection
        // gate -- a paragraph is still a plain text node, so none of the four
        // protected-node rules (delete/blank/to-do/complete) are in play.
        onSetKind: (id, kind, text) => {
          if (guardLocked(getTreeIndex(), id, rowOf(id))) return;
          const node = getTreeIndex().byId.get(id);
          if (kind === "embed") {
            if (guardProtected(id, "task", rowOf(id))) return;
            const url = embedUrl(text ?? node?.text ?? "");
            if (!url) return;
            text = url;
          }
          if (
            node?.kind === kind &&
            !node.isTask &&
            (text === undefined || node.text === text)
          )
            return;
          capture(getTreeIndex(), id, null, { label: "kind" });
          setKind(id, kind, text);
        },

        onSetLocked: (id, locked) => {
          const idx = getTreeIndex();
          const sourceId = trueSourceOf(idx, id);
          const node = idx.byId.get(sourceId);
          if (!node || node.locked === locked) return;
          capture(idx, sourceId, null, {
            label: "lock",
          });
          setLocked(sourceId, locked);
        },

        // Open the move picker; the dialog runs the mutation + navigation itself.
        onRequestMove: (id) => openMoveDialog(id),

        // Same picker in mirror mode; a pick creates a live mirror under the
        // chosen destination instead of reparenting (ADR 0022).
        onRequestMirror: (id) => openMoveDialog(id, "mirror"),

        onToggleCollapsed: (id, collapsed) => {
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
          // A view stream walks its rendered list, across sections (ADR 0070).
          const crossed = streamNeighbor(from, direction);
          const target =
            crossed !== undefined
              ? crossed
              : findVisibleNeighbor(
                  getTreeIndex(),
                  getViewRootId(),
                  from,
                  direction,
                  getViewIsHidden(),
                  getViewFilter(),
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

        setPendingFocus: (key, offset) => {
          pendingFocus.current = key;
          pendingFocusAtStart.current = false;
          setPendingCaretOffset(key, offset);
        },
      };
    },
    // commands MUST keep stable identity (a prop on every memoized OutlineRow,
    // ADR 0014). The live tree is read via getTreeIndex() and the live view
    // state via getViewRootId()/getViewIsHidden() (view-state.ts) at call time,
    // and the remaining live values through refs (refs/pendingFocus/...), so the
    // only real deps are the three stable callbacks; the module getters and the
    // flagged ref captures can't be listed and would defeat the pattern.
    // eslint-disable-next-line react-doctor/exhaustive-deps
    [navigateZoom, startDrag, consumeClick],
  );
}

/** Where a stream opens: AT the earlier of the anchor and `day`, so the page
 *  opens at the top like a single zoom view. Earlier sections load in above it
 *  with the scroll position held; a later `day` scrolls down to it once it
 *  renders. A `day` that is not a section of the stream is dropped. */
function planStreamOpening(
  stream: ViewStream | null,
  requested: string | null,
) {
  const offset = requested && stream ? stream.offsetOf(requested) : null;
  return {
    day: offset === null ? null : requested,
    range: {
      before: offset !== null && offset < 0 ? -offset : 0,
      after: Math.max(STREAM_CHUNK, (offset ?? 0) + STREAM_CHUNK),
    },
  };
}

/**
 * A view stream section's title (ADR 0070): the zoomed title, rendered as a
 * list item, so every section reads like its own zoom view. ArrowUp on its
 * first line continues into the previous section.
 */
const StreamSectionTitle = memo(function StreamSectionTitle({
  nodeId,
  isPivot,
  registerRef,
  getCtx,
  commands,
  pendingFocus,
}: {
  nodeId: string;
  isPivot: boolean;
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  getCtx: () => PluginContext;
  commands: NodeCommands;
  pendingFocus: RefObject<string | null>;
}) {
  const node = useNode(nodeId);
  if (!node) return null;
  return (
    <>
      <ZoomedTitle
        node={node}
        isPivot={isPivot}
        registerRef={registerRef}
        getCtx={getCtx}
        setPendingFocus={commands.setPendingFocus}
        onTextChange={(text) => commands.onTextChange(node.id, text)}
        onAddChild={() =>
          runStructural(() => {
            capture(getTreeIndex(), node.id, null, { label: "create" });
            pendingFocus.current = insertChildAtStart(getTreeIndex(), node.id);
          })
        }
        onArrowDown={() => commands.onMoveFocus(node.id, "down")}
        onArrowUp={() => commands.onMoveFocus(node.id, "up")}
      />
      <Backlinks nodeId={node.id} />
    </>
  );
});

/**
 * The zoomed node rendered as an editable page title. Mirrors OutlineRow's
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
  onArrowUp,
  setPendingFocus,
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
  /** ArrowUp on the title's first line. Only a view stream has something
   *  above a title (the previous section, ADR 0070). */
  onArrowUp?: () => void;
  /** Hand the caret to the seam bullet a structural paste created (ADR 0044). */
  setPendingFocus: (key: string, offset: number) => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  // Mirror OutlineRow's live inline-`code` decoration so a backtick run in the
  // title renders as a mono chip too. See inline-code.ts and OutlineRow.
  const syncedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const caretWatchRef = useRef<(() => void) | null>(null);
  useEditorFeatureDecoration(ref, composingRef);
  const { slotsByPosition } = usePluginChrome();
  // The protection rules (no delete/blank/to-do/complete) apply to the zoomed
  // node just as on a list bullet, so it wears the same indicator when zoomed.
  // Reactive: a plugin's protection can load async (mirrors OutlineRow). See
  // ADR 0015.
  const protectedNode = useIsProtected(node.id);
  const protection = protectedNode ? getProtection(node.id) : null;
  const locked = useIsLocked(node.id);

  // Mirror "appears in N places" badge on the zoomed title too (ADR 0022, slice
  // 1d), so a mirrored node shows the chrome whether it's a list bullet or the
  // page title. Session-fixed flag -> no reactive work when mirrors are off.
  const mirrorsOn = isMirrorsEnabled();
  const mirrorCount = useMirrorCount(node.id, mirrorsOn);

  // Plugin slots for the zoomed title (Seam F) plus the two core decorations
  // (protected lock, mirror badge), in ONE list -- the same composition as
  // OutlineRow's `row:before-text`, so the two render paths can't drift (see
  // docs/plugins.md "A node renders in three places"). Mirrors OutlineRow's order: slots,
  // then the lock, then the badge.
  const beforeTextSlots: SlotSpec[] = [
    ...(slotsByPosition.get("title:before-text") ?? []),
    {
      // A zoomed paragraph keeps its signifier -- muted and non-interactive,
      // since the title has nothing to zoom into (ADR 0045).
      id: "core:paragraph-mark",
      position: "title:before-text",
      render: () => <TitleParagraphGlyph kind={node.kind} />,
    },
    {
      id: "core:protection-indicator",
      position: "title:before-text",
      render: () =>
        protectedNode || locked ? (
          <ProtectionIndicator
            size={16}
            label={
              locked
                ? "Locked subtree"
                : (protection?.indicator?.label ?? "Protected node")
            }
            icon={locked ? LockIcon : protection?.indicator?.icon}
          />
        ) : null,
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
    // Same focused-skip as OutlineRow: don't paint a lagging/stale store over
    // local typing (classic echoedText + Lunora overlay gap).
    if (document.activeElement === el && !getHistoryState().busy) {
      if (echoedTextFor(node.id) === node.text) return;
      const dom = readSource(el);
      if (dom !== node.text && dom.startsWith(node.text)) return;
    }
    const focused = document.activeElement === el;
    const revealOffset = focused ? getCaretOffset(el) : null;
    decorate(el, node.text, revealOffset, focused);
    syncedRef.current = node.text;
  });

  // The `/` palette (Seam C) on the zoomed title too, mirroring OutlineRow --
  // so `/delete`, `/paragraph`, Move, Mirror, and every plugin `/` command work
  // whether the node is a list bullet or the page title (the two-render-paths
  // rule; see docs/plugins.md "A node renders in three places"). The title keymap below
  // is gated on `!slash.isOpen` so the menu's Enter/Arrow/Escape win while it's
  // open, exactly as OutlineRow gates useBulletKeymap.
  const slash = useSlashMenu({
    node,
    ctx: getCtx,
    getEl: () => ref.current,
    onTextChange,
  });

  // The caret menus (Seam H) on the title too, mirroring OutlineRow -- so the
  // `#` tag picker and the `[[` node-link picker open on the zoomed page title,
  // not just on list bullets. Same three-signal wiring as `slash`; the keymap
  // below is gated on `!menus.isOpen` as well so an open picker's Enter/Arrow
  // reach it.
  const menus = useMenus({
    node,
    getEl: () => ref.current,
    ctx: getCtx,
    onTextChange,
  });

  // Title shortcuts, scoped to the title's own contentEditable. Enter adds a
  // first child under the title; ArrowDown drops focus into the first child.
  // The plugin keymap (Seam D) is registered here too, so todos' Mod+Enter /
  // Mod+D toggle completion of the zoomed node just like on a list-item bullet.
  useHotkeys(
    [
      { hotkey: "Enter", callback: () => onAddChild() },
      { hotkey: "ArrowDown", callback: () => onArrowDown() },
      ...(onArrowUp
        ? [
            {
              hotkey: "ArrowUp" as const,
              callback: (e: KeyboardEvent) => {
                const el = ref.current;
                if (!el || !atLineStart(el)) return;
                e.preventDefault();
                onArrowUp();
              },
              options: { preventDefault: false },
            },
          ]
        : []),
      ...keymapSpecs.map((k) => ({
        // SAFETY: KeymapSpec.hotkey is documented as a react-hotkeys combo string
        hotkey: k.hotkey as UseHotkeyDefinition["hotkey"],
        callback: () => {
          const el = ref.current;
          if (
            k.hotkey === "Mod+Enter" &&
            el &&
            openInlineTargetAtCaret(el, getCtx(), { linkParens: "edit" })
          ) {
            return;
          }
          k.run(node.id, getCtx());
        },
      })),
    ],
    // Suspend the title keymap while the `/` palette OR a caret menu (#, [[) is
    // open, so their Enter/Arrow/Escape reach the menu (handleKeyDown) instead
    // of adding a child.
    { target: ref, enabled: !slash.isOpen && !menus.isOpen },
  );

  return (
    <>
      <h2 className="zoomed-title">
        {/* Block cell so a wrapped title flows UNDER the slot icons, mirroring
          the list row's .row-body (floated icons shorten only the first line
          box). A span, not a div -- an h2 only permits phrasing content. */}
        <span className="row-body">
          {beforeTextSlots.map((slot) => (
            <Fragment key={slot.id}>{slot.render(node, getCtx)}</Fragment>
          ))}
          <span
            ref={(el) => {
              ref.current = el;
              registerRef(node.id, el);
            }}
            className={`node-text zoomed-title-text${isPivot ? " vt-morph" : ""}`}
            data-kind={node.kind ?? undefined}
            style={isPivot ? { viewTransitionName: "zoom-target" } : undefined}
            contentEditable={!locked}
            tabIndex={locked ? 0 : undefined}
            suppressContentEditableWarning
            spellCheck={false}
            aria-label="Title"
            aria-readonly={locked}
            aria-multiline="true"
            data-completed={node.completed}
            data-history-key={node.id}
            data-history-node-id={node.id}
            onInput={(e) => {
              const el = e.currentTarget;
              const text = readSource(el);
              onTextChange(text);
              slash.handleInput();
              menus.handleInput();
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
              const next = pasteIntoBullet(
                e,
                el,
                node.id,
                getCtx,
                onTextChange,
                {
                  // THE exception (ADR 0044): the title's siblings live outside the
                  // view, so inserting one would make it vanish. Remaining pasted
                  // roots become the title's prepended children instead.
                  placement: "child-prepend",
                  activeKey: node.id,
                  rowEl: el.closest(".zoomed-title"),
                  focus: {
                    setPendingFocus,
                    placeCaretHere: (text, offset) => {
                      decorate(el, text, offset, true);
                      setCaretOffset(el, offset);
                      syncedRef.current = text;
                    },
                  },
                },
              );
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
              if (e.target !== e.currentTarget) return;
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
              if (!hasFoldingToken(node.text)) return;
              revealLinkAtCaret(el, (t) => {
                syncedRef.current = t;
              });
            }}
            onBlur={(e) => {
              if (e.target !== e.currentTarget) return;
              slash.close();
              menus.close();
              const el = e.currentTarget;
              caretWatchRef.current?.();
              caretWatchRef.current = null;
              if (
                e.relatedTarget instanceof HTMLElement &&
                el.contains(e.relatedTarget)
              )
                return;
              const text = readSource(el);
              // A protected node left empty heals: restore its name + shake/toast.
              const restored = healProtectedText(node.id, text, el);
              if (restored !== null) syncedRef.current = restored;
              else if (hasFoldingToken(text)) {
                decorate(el, text, null, false);
                syncedRef.current = text;
              }
            }}
            onKeyDown={(e) => {
              if (locked && e.key === "/" && !slash.isOpen) {
                e.preventDefault();
                slash.openWithoutInput();
                return;
              }
              // While a menu is open its Enter/Arrow/Escape/Tab are handled here;
              // the title keymap above is suspended, so these are the sole
              // consumers. Both no-op when closed. A caret menu (#, [[) wins over
              // the `/` palette (they never co-open, but mirror OutlineRow's order).
              if (menus.handleKeyDown(e)) return;
              slash.handleKeyDown(e);
            }}
          />
        </span>
        {/* Trailing decoration zone for the zoomed title (Seam F
          `title:after-text`, ADR 0031) -- mirrors OutlineRow's `row:after-text`
          so the two render paths can't drift. Dormant until a trailing slot
          registers. */}
        <NodeDecorations
          node={node}
          position="title:after-text"
          getCtx={getCtx}
        />
        {slash.menu}
        {menus.menu}
      </h2>
      <div data-title-body>
        <NodeBody node={node} position="title:body" getCtx={getCtx} />
      </div>
    </>
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
  // Two collapse shapes:
  //  - Mobile: a fixed, always-fits form -- Home > … > direct parent. Everything
  //    between Home and the immediate parent folds into the "…" menu, so the two
  //    anchors that matter (root + parent) are always visible and the row never
  //    needs to scroll.
  //  - Desktop: has room, so keep more context -- the first ancestor + the last
  //    two, folding only the deep middle (collapse fires at 5+ ancestors).
  const isMobile = useIsMobile();
  let lead: Node[];
  let hidden: Node[];
  let tail: Node[];
  if (isMobile) {
    // Drop the focused node itself -- it's the page title right below -- so the
    // trail ends at the direct parent: Home > … > parent.
    const ancestors = trail.slice(0, -1);
    lead = [];
    hidden = ancestors.slice(0, -1); // [] until there are 2+ ancestors
    tail = ancestors.slice(-1); // the direct parent (empty only at the top level)
  } else {
    // Only collapse when at least two crumbs would be hidden — folding a single
    // crumb into a "…" saves no space.
    const collapse = trail.length > LEADING + TRAILING + 1;
    lead = collapse ? trail.slice(0, LEADING) : trail;
    hidden = collapse ? trail.slice(LEADING, trail.length - TRAILING) : [];
    tail = collapse ? trail.slice(trail.length - TRAILING) : [];
  }

  // Safety net for the desktop trail: if a narrowed window still overflows, the
  // row scrolls horizontally (rather than squishing crumbs) and lands on the
  // deepest crumb. The mobile compact form never needs this -- it flex-shrinks
  // the single parent crumb to fit (see .breadcrumb[data-compact] in styles.css).
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = navRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [rootId, trail.length]);

  return (
    <nav
      ref={navRef}
      className="breadcrumb scroll-fade-x"
      aria-label="Breadcrumb"
      data-compact={isMobile ? "" : undefined}
    >
      {/* Zooming out: the current root is the pivot (title -> list item). */}
      <Button
        type="button"
        size="icon"
        variant="ghost"
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
      {rootId && hidden.length > 0 && (
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
        {crumbLabel(ancestor)}
      </button>
    </span>
  );
}

/**
 * A crumb's display text: the node's PLAIN READING TEXT, never its source (#279).
 *
 * `flattenNodeText` is the same funnel the switcher titles and mirror-place
 * labels read through, and `inline-text.ts` names breadcrumb crumbs in its own
 * list of consumers — this surface was simply never wired to it, so a node
 * titled `**Sprint goals**` wore its asterisks in the trail.
 *
 * Flattening rather than RENDERING the markup is the deliberate call. A crumb is
 * 12px wayfinding chrome that ellipsis-truncates; bold and code chips inside it
 * compete with the trail's own hierarchy. More decisively, a title can hold the
 * whole inline grammar — `[[node-links]]`, date tokens, `==highlights==` with a
 * leading colour emoji, `||spoilers||` — so a renderer covering only the four
 * forms #279 lists would leave the rest raw: the same bug, in a new coat. This
 * one call covers all of it, and a link folds to its label rather than its URL.
 *
 * `getTreeIndex()` (not `useTreeIndex()`) on purpose: node-link resolution needs
 * the index, but SUBSCRIBING the trail to it would re-render every crumb on
 * every keystroke anywhere in the outline. The trail's nodes already arrive from
 * `useTrail`, so the read is fresh whenever a crumb's own text changes. Same
 * pattern as `NodeDecorations`.
 */
function crumbLabel(ancestor: Node): string {
  return flattenNodeText(getTreeIndex(), ancestor.text).trim() || "Untitled";
}

/**
 * The collapsed middle of a deep trail. The "…" opens the hidden ancestors in a
 * dropdown menu. Uses the shared Base UI menu (like the header's More menu) so
 * its panel is *portaled* to the body -- essential here, since the breadcrumb is
 * a horizontal scroll container and a CSS-positioned panel would be clipped by
 * its overflow. Portaling also gives touch (tap-to-open), keyboard navigation,
 * and menu ARIA for free.
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
      <DropdownMenu title="Breadcrumbs">
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="crumb-ellipsis"
              aria-label="Show hidden breadcrumbs"
            >
              <MoreHorizontal size={14} strokeWidth={2} />
            </button>
          }
        />
        {/* Explicit width overrides the shared content's `w-(--anchor-width)`,
            which would otherwise pin the panel to the tiny "…" trigger's width.
            Near-full-viewport on mobile, capped at 22rem on desktop; each label
            ellipsis-truncates within it. */}
        <DropdownMenuContent
          align="start"
          className="w-[min(22rem,calc(100vw-1.5rem))]"
        >
          {hidden.map((ancestor) => (
            <DropdownMenuItem
              key={ancestor.id}
              onClick={() => onNavigate(ancestor.id, rootId)}
            >
              <span className="min-w-0 flex-1 truncate">
                {crumbLabel(ancestor)}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

function prefersReducedMotion(): boolean {
  return (
    hasWindow() &&
    hasMatchMedia() &&
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
