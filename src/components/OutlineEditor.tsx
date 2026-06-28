import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
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
import {
  ChevronRight,
  HomeIcon,
  MoreHorizontal,
  PlusIcon,
} from "lucide-react";
import { useTree } from "../data/useTree";
import { getTreeIndex } from "../data/tree-store";
import {
  getViewIsHidden,
  getViewRootId,
  useSyncViewState,
} from "../data/view-state";
import { buildTrail, childrenOf, type Node, type TreeIndex } from "../data/tree";
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
import { pasteIntoBullet } from "./paste";
import {
  blocksCaret,
  buildViewFilter,
  composeHidden,
  dispatchClick,
  dispatchContextMenu,
  getProtection,
  keymapSpecs,
} from "../plugins/registry";
import type { PluginContext, ViewContext } from "../plugins/types";
import { useDragReorder } from "./use-drag-reorder";
import { consumeFlashAfterNav, flashRow, rejectRow } from "./flash-node";
import { healProtectedText } from "./protected-text";
import { toast } from "sonner";
import { Header } from "./Header";
import { Subheader } from "./Subheader";
import { DailyNavigationProgress } from "../plugins/daily/navigation-progress";
import { useShowCompleted } from "./show-completed-provider";
import { openMoveDialog } from "./move-dialog-opener";
import { Button } from "./ui/button";

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

/**
 * Top-level outline editor. Owns:
 *  - reading the live tree
 *  - seeding on first run
 *  - focus management across bullets
 *  - translating keyboard commands into mutations
 *  - the zoom view (breadcrumb + editable title) when rootId is set
 */
export function OutlineEditor({ rootId }: OutlineEditorProps) {
  const { index } = useTree();
  const navigate = useNavigate();
  const { showCompleted } = useShowCompleted();

  // Event-time reads of the live tree go through tree-store's getTreeIndex()
  // (same value as `index`, read at call time), so the stable command/drag
  // closures don't depend on this render's `index` and `commands` keeps its
  // identity across renders -- a prop on every memoized OutlineNode (ADR 0014).
  // Render reads below use `index` from useTree() so they stay reactive.

  // First-run import-or-seed bootstrap; safe to run on mount. See seed.ts.
  useBootstrapOutline();

  const routeSearch = useSearch({ strict: false }) as { q?: string };

  // Seam G (ADR 0018): the composed per-node visibility predicate. The core no
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
  const { refs, registerRef, pendingFocus, pendingFocusAtStart, pendingFlash } =
    useOutlineFocus();

  // The top-level <ul>, so the drag indicator knows how wide to draw.
  const listRef = useRef<HTMLUListElement | null>(null);

  // Zoom navigation: the shared-element morph between a node's title and list-
  // item roles, Cmd+, zoom-out, the current pivot id, and the post-navigation
  // focus landing. See useZoomNavigation.
  const { navigateZoom, pivotId } = useZoomNavigation({
    index,
    rootId,
    isHidden,
    refs,
    navigate,
  });



  // Delegated tag-chip interaction. Chips live inside contentEditable text, so a
  // plain mousedown would place an editing caret; we block that and route the
  // click to the filter instead. On touch a transient caret may flash before
  // the navigation, which re-prunes the view -- accepted for v1 (ADR 0015).
  // Delegated interaction (Seam B). Chips/links live inside the contentEditable,
  // so the core runs ONE set of handlers on the content container and dispatches
  // to whichever plugin owns the surface under the pointer (registry.ts). The
  // core has zero feature knowledge -- a folded link opens, a tag chip filters,
  // a right-click picks a color, all decided by the plugins. See ADR 0018.
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
  // is a thin host -- the overlay portals + dismisses itself (ADR 0018 Seam B).
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
    getRowEl: (id) =>
      (refs.current.get(id)?.closest(".outline-row") as HTMLElement | null) ??
      null,
    getListEl: () => listRef.current,
    onMove: (id, newParentId, afterSiblingId) =>
      runStructural(() => {
        const index = getTreeIndex();
        capture(index, id);
        const moved = moveNode(index, id, newParentId, afterSiblingId);
        if (moved) {
          pendingFocus.current = id;
          // Tint the row it landed on so the eye can find what just moved.
          pendingFlash.current = id;
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
    navigateZoom,
    startDrag,
    consumeClick,
  });

  // PluginContext factory (ADR 0018 D8): the promoted command set + tree reads +
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

  // The pruned visible-set for the active filter (matches + ancestor context),
  // or null when no filter. Now a plugin-contributed Seam-G transform (the tags
  // plugin's tag-filter), composed in registry.buildViewFilter -- the core no
  // longer imports buildTagFilter directly. Render-time only, never mutates a
  // node (ADR 0015). The composed isHidden is passed so it prunes hidden nodes.
  const filter = useMemo(
    () => buildViewFilter(index, viewCtx, isHidden),
    [index, viewCtx, isHidden],
  );
  const noMatches = filter !== null && filter.matchIds.size === 0;

  // Top-level roots start the fade cascade fresh: a completed ancestor above
  // the current view (when zoomed) contributes nothing. Apply the composed
  // visibility prune (hide-completed when the toggle is off), and -- while
  // filtering -- keep only the ones on a path to a match.
  const topLevel = childrenOf(index, rootId)
    .filter((n) => !isHidden(n) && (!filter || filter.visibleIds.has(n.id)));
  const zoomedNode = rootId ? (index.byId.get(rootId) ?? null) : null;
  const trail = buildTrail(index, rootId);

  // Deep-linked to a node that no longer exists (and the store has loaded).
  if (rootId !== null && zoomedNode === null && index.byId.size > 0) {
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
      <div className="sticky top-0 z-10 relative">
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
                const newId = insertChildAtStart(
                  getTreeIndex(),
                  zoomedNode.id,
                );
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
            <ul className="outline-list" ref={listRef}>
              {topLevel.map((node) => (
                <OutlineNode
                  key={node.id}
                  nodeId={node.id}
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
  /** id -> contentEditable span. The zoomed title registers under rootId too,
   *  so focus logic treats titles and list items uniformly. */
  refs: RefObject<Map<string, HTMLSpanElement | null>>;
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  /** The node to focus after the next render (most-recently inserted/moved). */
  pendingFocus: RefObject<string | null>;
  /** When an Enter-split moved text into the new bullet, land the caret at its
   *  START, not its end (every other pending-focus wants the end). */
  pendingFocusAtStart: RefObject<boolean>;
  /** Like pendingFocus, but pulses the row's background to mark a just-moved
   *  node (set after a drag/keyboard move). */
  pendingFlash: RefObject<string | null>;
}

/**
 * Focus plumbing for the editor: the id->span registry, the after-render focus/
 * flash pass, and undo/redo (which restore focus to the node the undone action
 * left it on). Split out of OutlineEditor so the body stays readable; the refs
 * are returned so the command closures and drag can write them. See ADR 0014.
 */
function useOutlineFocus(): OutlineFocus {
  // The refs registry. Lazy-init the Map once: useRef has no lazy-initializer
  // form, so passing `new Map()` directly would rebuild and discard it on every
  // render. (react-doctor/rerender-lazy-ref-init.)
  const refs = useRef<Map<string, HTMLSpanElement | null>>(null!);
  if (!refs.current) refs.current = new Map();
  const registerRef = useCallback((id: string, el: HTMLSpanElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);

  const pendingFocus = useRef<string | null>(null);
  const pendingFocusAtStart = useRef(false);
  const pendingFlash = useRef<string | null>(null);

  // After every render, if a focus is pending and the target exists, focus it;
  // likewise flash a just-moved row. Both run post-render because the target row
  // only exists after the structural mutation's render.
  useEffect(() => {
    if (pendingFocus.current) {
      const el = refs.current.get(pendingFocus.current);
      if (el) {
        el.focus();
        if (pendingFocusAtStart.current) placeCaretAtStart(el);
        else placeCaretAtEnd(el);
      }
      pendingFocus.current = null;
      pendingFocusAtStart.current = false;
    }
    if (pendingFlash.current) {
      const el = refs.current.get(pendingFlash.current);
      flashRow(el?.closest(".outline-row") ?? null);
      pendingFlash.current = null;
    }
  });

  // The currently-focused bullet id, by reverse-looking-up the registry (covers
  // list items and the zoomed title). Null when focus is outside the outline.
  const findFocusedId = useCallback((): string | null => {
    const active = document.activeElement;
    for (const [id, el] of refs.current) {
      if (el === active) return id;
    }
    return null;
  }, []);

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

  return { refs, registerRef, pendingFocus, pendingFocusAtStart, pendingFlash };
}

interface ZoomNavigationArgs {
  index: TreeIndex;
  rootId: string | null;
  isHidden: (node: Node) => boolean;
  refs: RefObject<Map<string, HTMLSpanElement | null>>;
  navigate: ReturnType<typeof useNavigate>;
}

/**
 * Zoom navigation: the shared-element morph between a node's title and list-item
 * roles, Cmd+, zoom-out, and the focus landing after a navigation. Returns the
 * stable `navigateZoom` and the current pivot id. The mount-only effects rely on
 * the editor remounting per zoom view (ADR 0003's `key={nodeId}`).
 */
function useZoomNavigation({
  index,
  rootId,
  isHidden,
  refs,
  navigate,
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
        const prevEl = refs.current.get(prev);
        prevEl?.style.removeProperty("view-transition-name");
        prevEl?.classList.remove("vt-morph");
      }
      const el = refs.current.get(pivot);
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
      const firstChild = childrenOf(index, rootId).find((n) => !isHidden(n));
      if (firstChild) targetId = firstChild.id;
    }
    const el = refs.current.get(targetId);
    if (!el) return;
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
    const el = refs.current.get(flashId);
    if (!el) return;
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

interface NodeCommandsArgs {
  refs: RefObject<Map<string, HTMLSpanElement | null>>;
  pendingFocus: RefObject<string | null>;
  pendingFocusAtStart: RefObject<boolean>;
  pendingFlash: RefObject<string | null>;
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
  navigateZoom,
  startDrag,
  consumeClick,
}: NodeCommandsArgs): NodeCommands {
  return useMemo<NodeCommands>(
    () => ({
      onTextChange: (id, text) => {
        // Coalesce a run of keystrokes on one bullet into a single undo step,
        // capturing the pre-typing state on the first keystroke of the run.
        capture(getTreeIndex(), id, `text:${id}`);
        setText(id, text);
      },

      onEnter: (id, caretOffset) =>
        runStructural(() => {
          const node = getTreeIndex().byId.get(id);
          if (!node) return;
          capture(getTreeIndex(), id);
          const offset = Math.max(0, Math.min(caretOffset, node.text.length));
          const before = node.text.slice(0, offset);
          const after = node.text.slice(offset);
          const caretAtEnd = after.length === 0;
          // Pressing Enter at the end of an open (expanded, has-children) bullet
          // adds a child at the top of its list rather than a sibling -- you're
          // diving into the thing you just finished naming. Anywhere else keeps
          // the plain new-sibling.
          const isOpen =
            !node.collapsed && childrenOf(getTreeIndex(), id).length > 0;
          if (caretAtEnd && isOpen) {
            pendingFocus.current = insertChildAtStart(
              getTreeIndex(),
              id,
              node.isTask,
            );
            return;
          }
          // Split at the caret: text left of it stays on this node, text to its
          // right seeds the new sibling. (Caret at the end is just `after === ""`.)
          const newId = insertSibling(
            getTreeIndex(),
            node.parentId,
            id,
            node.isTask,
            after,
          );
          if (!caretAtEnd) {
            setText(id, before);
            // Caret sits before the moved text, where the split happened.
            pendingFocusAtStart.current = true;
          }
          pendingFocus.current = newId;
        }),

      onIndent: (id) =>
        runStructural(() => {
          // Moving the node reparents it into a different <ul>, which remounts
          // its contentEditable and drops focus. Re-focus it after the render.
          capture(getTreeIndex(), id);
          if (indent(getTreeIndex(), id)) {
            pendingFocus.current = id;
            pendingFlash.current = id;
          } else drop(); // no move happened; discard the redundant undo point
        }),

      onOutdent: (id) =>
        runStructural(() => {
          // Don't let a direct child of the zoom root outdent past it; that
          // would move it out of the visible subtree and look like it vanished.
          const node = getTreeIndex().byId.get(id);
          if (node && node.parentId === getViewRootId()) return;
          // Same remount-drops-focus issue as indent; re-focus on a real move.
          capture(getTreeIndex(), id);
          if (outdent(getTreeIndex(), id)) {
            pendingFocus.current = id;
            pendingFlash.current = id;
          } else drop();
        }),

      onMoveUp: (id) =>
        runStructural(() => {
          // Reorder/outdent remounts the contentEditable; re-focus on a real move.
          capture(getTreeIndex(), id);
          const moved = moveUp(getTreeIndex(), id, {
            isVisible: (n) => !getViewIsHidden()(n),
            rootId: getViewRootId(),
          });
          if (moved) {
            pendingFocus.current = id;
            pendingFlash.current = id;
          } else drop();
        }),

      onMoveDown: (id) =>
        runStructural(() => {
          capture(getTreeIndex(), id);
          const moved = moveDown(getTreeIndex(), id, {
            isVisible: (n) => !getViewIsHidden()(n),
            rootId: getViewRootId(),
          });
          if (moved) {
            pendingFocus.current = id;
            pendingFlash.current = id;
          } else drop();
        }),

      onDeleteNode: (id) =>
        runStructural(() => {
          // A plugin can protect a node from deletion (the daily container). The
          // core no-ops here -- the single funnel every delete path flows through
          // -- but shakes the row and toasts the plugin's reason so the block
          // reads as intentional, not a dropped keystroke. The node isn't
          // removed, so its row still exists.
          const protection = getProtection(id);
          if (protection) {
            rejectRow(refs.current.get(id)?.closest(".outline-row") ?? null);
            if (protection.reason)
              toast.error(protection.reason, { id: "protected-delete" });
            return;
          }
          capture(getTreeIndex(), id);
          // Focus the row directly ABOVE the deleted one (Workflowy backspace
          // behavior), computed before the mutation so the neighbor still
          // exists. Fall back to removeNode's structural pick (next sibling /
          // parent) only when nothing is above -- the first visible row.
          const above = findVisibleNeighbor(
            getTreeIndex(),
            getViewRootId(),
            id,
            "up",
            getViewIsHidden(),
          );
          const focusId = removeNode(getTreeIndex(), id);
          const target = above ?? focusId;
          if (target) pendingFocus.current = target;
          else drop(); // node didn't exist; nothing was deleted
        }),

      onToggleCompleted: (id, completed) => {
        capture(getTreeIndex(), id);
        toggleCompleted(id, completed);
      },

      onSetTask: (id, isTask) => {
        // A protected node is structural (the daily container holds the day
        // notes) and stays a plain text node -- it can't become a to-do. Reject
        // the conversion with the same shake + toast as a blocked delete; this
        // funnel catches every task-creation path (`/todo`, the `[]`
        // autoformat). Un-tasking (isTask=false) is always allowed.
        if (isTask) {
          const protection = getProtection(id);
          if (protection) {
            rejectRow(refs.current.get(id)?.closest(".outline-row") ?? null);
            const message = protection.taskReason ?? protection.reason;
            if (message) toast.error(message, { id: "protected-task" });
            return;
          }
        }
        capture(getTreeIndex(), id);
        setIsTask(id, isTask);
      },

      // Open the move picker; the dialog runs the mutation + navigation itself.
      onRequestMove: (id) => openMoveDialog(id),

      onToggleCollapsed: (id, collapsed) => {
        capture(getTreeIndex(), id);
        toggleCollapsed(id, collapsed);
      },

      onMoveFocus: (id, direction, x) => {
        const target = findVisibleNeighbor(
          getTreeIndex(),
          getViewRootId(),
          id,
          direction,
          getViewIsHidden(),
        );
        if (target) {
          const el = refs.current.get(target);
          if (el) {
            el.focus();
            if (x != null) placeCaretAtColumn(el, direction, x);
            else placeCaretAtStart(el);
          }
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
    }),
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
        callback: () => k.run(node.id, getCtx()),
      })),
    ],
    { target: ref },
  );

  return (
    <h2 className="zoomed-title">
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
          const next = pasteIntoBullet(e, el, onTextChange);
          if (next !== null) syncedRef.current = next;
        }}
        onFocus={(e) => {
          // Per-link reveal in the title (ADR 0017): watch the caret, and
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
          revealLinkAtCaret(el, node.text, () => {
            syncedRef.current = node.text;
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

/**
 * Walk the visible (non-collapsed) outline in display order within the
 * current zoom root and return the id of the node immediately before/after
 * `id`, or null if none. The zoom root (the title) is the first entry, so
 * ArrowUp from the first child lands on the title.
 */
function findVisibleNeighbor(
  index: TreeIndex,
  rootId: string | null,
  id: string,
  direction: "up" | "down",
  isHidden: (n: Node) => boolean,
): string | null {
  const flat = flattenVisible(index, rootId, isHidden);
  const i = flat.findIndex((n) => n.id === id);
  if (i === -1) return null;
  const neighbor = direction === "up" ? flat[i - 1] : flat[i + 1];
  return neighbor ? neighbor.id : null;
}

function flattenVisible(
  index: TreeIndex,
  rootId: string | null,
  isHidden: (n: Node) => boolean,
): Array<{ id: string }> {
  const out: Array<{ id: string }> = [];
  // The zoomed title participates in up/down navigation.
  if (rootId) out.push({ id: rootId });
  const walk = (parentId: string | null) => {
    for (const child of childrenOf(index, parentId)) {
      // Mirror the render's visibility (the composed Seam-G prune): a hidden
      // node (e.g. completed while show-completed is off) and its subtree are
      // absent from the DOM. Keeping them here would make findVisibleNeighbor
      // return an id with no mounted element, so onMoveFocus silently no-ops
      // and focus gets stuck.
      if (isHidden(child)) continue;
      out.push({ id: child.id });
      if (!child.collapsed) walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function placeCaretAtStart(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
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
