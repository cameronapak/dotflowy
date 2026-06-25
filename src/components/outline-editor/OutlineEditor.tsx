import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router";
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

  const focusIndex = useRef<TreeIndex>(index);
  focusIndex.current = index;

  useBootstrapOutline();

  const { activeTags, activeTagsRef, addTag, removeTag, clearTags, setQ } =
    useTagFilter(rootId, navigate);

  const viewCtx = useMemo<ViewContext>(
    () => ({ showCompleted, search: activeTags, rootId }),
    [showCompleted, activeTags, rootId],
  );
  const isHidden = useMemo(() => composeHidden(viewCtx), [viewCtx]);
  const isHiddenRef = useRef(isHidden);
  isHiddenRef.current = isHidden;

  const rootIdRef = useRef<string | null>(rootId);
  rootIdRef.current = rootId;

  const { refs, registerRef, pendingFocus, pendingFocusAtStart, pendingFlash } =
    useOutlineFocus(focusIndex);

  const listRef = useRef<HTMLUListElement | null>(null);

  const { navigateZoom, pivotId } = useZoomNavigation({
    index,
    rootId,
    isHidden,
    refs,
    focusIndex,
    navigate,
  });

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
  const [overlayNode, setOverlayNode] = useState<ReactNode>(null);
  const onContentContextMenu = (e: ReactMouseEvent) => {
    dispatchContextMenu(e.target as HTMLElement, pluginCtx(), e);
  };

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
        pendingFlash.current = id;
      } else drop();
    },
  });
  const { startDrag, consumeClick } = drag;

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
    [commands, navigateZoom, addTag, setQ, activeTagsRef],
  );

  const filter = useMemo(
    () => buildViewFilter(index, viewCtx, isHidden),
    [index, viewCtx, isHidden],
  );
  const noMatches = filter !== null && filter.matchIds.size === 0;

  const topLevel = childrenOf(index, rootId)
    .filter((n) => !isHidden(n) && (!filter || filter.visibleIds.has(n.id)));
  const zoomedNode = rootId ? (index.byId.get(rootId) ?? null) : null;
  const trail = buildTrail(index, rootId);

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
            {filter?.emptyMessage ??
              `No nodes tagged ${activeTags.join(" ")} here.`}
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
