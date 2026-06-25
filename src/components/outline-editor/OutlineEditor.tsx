import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useTree } from "../../data/useTree";
import { buildTrail, childrenOf, type TreeIndex } from "../../data/tree";
import {
  insertChildAtStart,
  insertSibling,
  moveNode,
  setText,
} from "../../data/mutations";
import { capture, drop } from "../../data/history";
import { OutlineNode } from "../OutlineNode";
import {
  buildViewFilter,
  composeHidden,
  dispatchClick,
  dispatchContextMenu,
} from "../../plugins/registry";
import type { PluginContext, ViewContext } from "../../plugins/types";
import { useDragReorder } from "../use-drag-reorder";
import { Header } from "../Header";
import { useShowCompleted } from "../../plugins/todos/show-completed-provider";
import { Button } from "../ui/button";
import { BreadcrumbTrail } from "./breadcrumb-trail";
import { onContentMouseDown } from "./on-content-interaction";
import { TagFilterBar } from "./tag-filter-bar";
import { useBootstrapOutline } from "./use-bootstrap-outline";
import { useNodeCommands } from "./use-node-commands";
import { useOutlineFocus } from "./use-outline-focus";
import { useTagFilter } from "./use-tag-filter";
import { useZoomNavigation } from "./use-zoom-navigation";
import { ZoomedTitle } from "./zoomed-title";

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

  // Live handle to the current tree for the stable command/drag closures (the
  // ref pattern every live value uses, so `commands` keeps its identity across
  // renders -- a prop on every memoized OutlineNode. See ADR 0014).
  const focusIndex = useRef<TreeIndex>(index);
  focusIndex.current = index;

  // First-run import-or-seed bootstrap; safe to run on mount. See seed.ts.
  useBootstrapOutline();

  // URL-driven tag filter (?q=, ADR 0015): the active tags plus the stable
  // chip-click / filter-bar handlers and escape-to-clear. See useTagFilter.
  const { activeTags, activeTagsRef, addTag, removeTag, clearTags, setQ } =
    useTagFilter(rootId, navigate);

  // Seam G (ADR 0018): the composed per-node visibility predicate. The core no
  // longer hardcodes `completed` -- it hides whatever the plugin view transforms
  // hide (hide-completed today). Memoized so it stays referentially stable
  // across keystrokes, which keeps useVisibleChildIds' cache warm and every
  // memoized OutlineNode from re-rendering on a sibling's keystroke (ADR 0014).
  // Depends on the whole view context for forward-correctness, though today's
  // only hide rule reads showCompleted.
  const viewCtx = useMemo<ViewContext>(
    () => ({ showCompleted, search: activeTags, rootId }),
    [showCompleted, activeTags, rootId],
  );
  const isHidden = useMemo(() => composeHidden(viewCtx), [viewCtx]);
  // Live handle for the stable command closures + drag (mirrors the ref pattern
  // the other live values use, so `commands` keeps its identity -- ADR 0014).
  const isHiddenRef = useRef(isHidden);
  isHiddenRef.current = isHidden;

  const rootIdRef = useRef<string | null>(rootId);
  rootIdRef.current = rootId;

  // Focus plumbing: the id->contentEditable registry, the post-render focus/
  // flash pass, and undo/redo (which restore focus where the action left it).
  // The refs are returned so the command closures + drag can write them. See
  // useOutlineFocus.
  const { refs, registerRef, pendingFocus, pendingFocusAtStart, pendingFlash } =
    useOutlineFocus(focusIndex);

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
    focusIndex,
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
    getIndex: () => focusIndex.current,
    getRootId: () => rootIdRef.current,
    getIsHidden: () => isHiddenRef.current,
    getRowEl: (id) =>
      (refs.current.get(id)?.closest(".outline-row") as HTMLElement | null) ??
      null,
    getListEl: () => listRef.current,
    onMove: (id, newParentId, afterSiblingId) => {
      capture(focusIndex.current, id);
      const moved = moveNode(
        focusIndex.current,
        id,
        newParentId,
        afterSiblingId,
      );
      if (moved) {
        pendingFocus.current = id;
        // Tint the row it landed on so the eye can find what just moved.
        pendingFlash.current = id;
      } else drop();
    },
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
    focusIndex,
    rootIdRef,
    isHiddenRef,
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
  // live values (focusIndex/activeTagsRef) at call time; stable identity.
  const pluginCtx = useCallback(
    (): PluginContext => ({
      tree: focusIndex.current,
      mutations: commands,
      nav: {
        zoom: (id) => navigateZoom(id, id),
        filterTag: (tag) => addTag(tag),
        setSearch: (tags) => setQ(tags),
      },
      search: activeTagsRef.current,
      openOverlay: (node) => setOverlayNode(node),
    }),
    // activeTagsRef is a stable ref (read at call time); listing the ref itself
    // -- not activeTagsRef.current -- keeps pluginCtx referentially stable.
    [commands, navigateZoom, addTag, setQ, activeTagsRef],
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
      <Header getCtx={pluginCtx}>
        <BreadcrumbTrail
          trail={trail}
          rootId={rootId || null}
          onNavigate={navigateZoom}
        />
      </Header>
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
        {activeTags.length > 0 && (
          <TagFilterBar
            tags={activeTags}
            onRemove={removeTag}
            onClear={clearTags}
          />
        )}

        {zoomedNode && (
          <ZoomedTitle
            node={zoomedNode}
            isPivot={pivotId === zoomedNode.id}
            registerRef={registerRef}
            getCtx={pluginCtx}
            onTextChange={(text) => setText(zoomedNode.id, text)}
            onAddChild={() => {
              const newId = insertChildAtStart(
                focusIndex.current,
                zoomedNode.id,
              );
              pendingFocus.current = newId;
            }}
            onArrowDown={() => commands.onMoveFocus(zoomedNode.id, "down")}
          />
        )}

        {noMatches ? (
          <div className="outline-empty">
            No nodes tagged {activeTags.join(" ")} here.
          </div>
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
                  ancestorFaded={false}
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
                onClick={() => {
                  const siblings = childrenOf(focusIndex.current, rootId);
                  const afterId = siblings.length
                    ? siblings[siblings.length - 1]!.id
                    : null;
                  const newId = insertSibling(
                    focusIndex.current,
                    rootId,
                    afterId,
                  );
                  pendingFocus.current = newId;
                }}
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
