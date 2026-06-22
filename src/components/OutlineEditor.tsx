import { useCallback, useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useHotkey, useHotkeys } from "@tanstack/react-hotkeys";
import { ChevronRight, HomeIcon, MoreHorizontal, PlusIcon } from "lucide-react";
import { useTree } from "../data/useTree";
import { childrenOf, type Node, type TreeIndex } from "../data/tree";
import {
  indent,
  insertChildAtStart,
  insertSibling,
  outdent,
  removeNode,
  setIsTask,
  setText,
  toggleCollapsed,
  toggleCompleted,
} from "../data/mutations";
import { seedIfEmpty } from "../data/seed";
import { capture, drop, undo } from "../data/history";
import { OutlineNode, type NodeCommands } from "./OutlineNode";
import { Header } from "./Header";
import { useShowCompleted } from "./show-completed-provider";
import { Button } from "./ui/button";

// Carry the zoom "pivot" (the node morphing between title and list-item) in
// history state, so the incoming view knows which element to name.
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

  // Refs registry: id -> contentEditable span. Lets us move focus
  // between bullets after structural mutations. The zoomed title also
  // registers here under rootId, so focus logic treats it uniformly.
  const refs = useRef<Map<string, HTMLSpanElement | null>>(new Map());
  const registerRef = useCallback((id: string, el: HTMLSpanElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);

  // First-run seed. Runs when the collection has loaded and is empty.
  useEffect(() => {
    // hasAnyNode is true if any node at all exists. We can't tell "loaded
    // but empty" from "not yet loaded" purely from useLiveQuery in v1;
    // localStorage is synchronous though, so reading the raw key is safe.
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("dotflowy-oss:nodes")
        : null;
    if (raw === null) seedIfEmpty(false);
  }, []);

  // Track the most recently inserted/focused node id so we can focus it
  // after the next render. Storing in a ref + state-like cursor.
  const pendingFocus = useRef<string | null>(null);

  // After every render, if a focus is pending and the target exists, focus it.
  useEffect(() => {
    if (pendingFocus.current) {
      const el = refs.current.get(pendingFocus.current);
      if (el) {
        el.focus();
        // Place caret at end for natural typing flow.
        placeCaretAtEnd(el);
      }
      pendingFocus.current = null;
    }
  });

  const focusIndex = useRef<TreeIndex>(index);
  focusIndex.current = index;
  // Keep the live rootId available inside command closures.
  const rootIdRef = useRef<string | null>(rootId);
  rootIdRef.current = rootId;

  // Cmd/Ctrl+D toggles completion on the focused bullet. Every bullet is
  // completable (not just tasks), so this works regardless of isTask. We find
  // the focused node by reverse-looking-up the refs registry, which covers
  // both list items and the zoomed title (registered under rootId).
  useHotkey(
    "Mod+D",
    () => {
      const active = document.activeElement;
      let focusedId: string | null = null;
      for (const [id, el] of refs.current) {
        if (el === active) {
          focusedId = id;
          break;
        }
      }
      if (!focusedId) return;
      const node = focusIndex.current.byId.get(focusedId);
      if (!node) return;
      capture(focusIndex.current, focusedId);
      toggleCompleted(focusedId, !node.completed);
    },
    { preventDefault: true },
  );

  // Cmd/Ctrl+Z: undo the last action. preventDefault stops the browser's
  // native contentEditable undo so we own history. Restores focus to the
  // node that was focused before the undone action, when it still exists.
  useHotkey(
    "Mod+Z",
    () => {
      const focusId = undo(focusIndex.current);
      if (focusId) pendingFocus.current = focusId;
    },
    { preventDefault: true },
  );

  // The "pivot" of the last zoom: the node that swaps between title and
  // list-item roles. The incoming view reads it from history state and names
  // that node's element so the browser morphs it across the navigation.
  const location = useLocation();
  const pivotId = location.state.pivotId ?? null;
  const pivotIdRef = useRef<string | null>(pivotId);
  pivotIdRef.current = pivotId;

  /**
   * Navigate to a new zoom root with a shared-element morph. `pivot` is the
   * node that changes role: the target when zooming in (list item -> title),
   * the current root when zooming out (title -> list item). We name the pivot
   * in the OUTGOING view here; the incoming view names it declaratively.
   */
  const navigateZoom = (toRootId: string | null, pivot: string) => {
    if (prefersReducedMotion()) {
      if (toRootId === null) navigate({ to: "/" });
      else navigate({ to: "/$nodeId", params: { nodeId: toRootId } });
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
  };

  const commands: NodeCommands = {
    onTextChange: (id, text) => {
      // Coalesce a run of keystrokes on one bullet into a single undo step,
      // capturing the pre-typing state on the first keystroke of the run.
      capture(focusIndex.current, id, `text:${id}`);
      setText(id, text);
    },

    onEnter: (id) => {
      const node = focusIndex.current.byId.get(id);
      if (!node) return;
      capture(focusIndex.current, id);
      const newId = insertSibling(focusIndex.current, node.parentId, id);
      pendingFocus.current = newId;
    },

    onIndent: (id) => {
      // Moving the node reparents it into a different <ul>, which remounts
      // its contentEditable and drops focus. Re-focus it after the render.
      capture(focusIndex.current, id);
      if (indent(focusIndex.current, id)) pendingFocus.current = id;
      else drop(); // no move happened; discard the redundant undo point
    },

    onOutdent: (id) => {
      // Don't let a direct child of the zoom root outdent past it; that
      // would move it out of the visible subtree and look like it vanished.
      const node = focusIndex.current.byId.get(id);
      if (node && node.parentId === rootIdRef.current) return;
      // Same remount-drops-focus issue as indent; re-focus on a real move.
      capture(focusIndex.current, id);
      if (outdent(focusIndex.current, id)) pendingFocus.current = id;
      else drop();
    },

    onDeleteNode: (id) => {
      capture(focusIndex.current, id);
      const focusId = removeNode(focusIndex.current, id);
      if (focusId) pendingFocus.current = focusId;
      else drop(); // node didn't exist; nothing was deleted
    },

    onToggleCompleted: (id, completed) => {
      capture(focusIndex.current, id);
      toggleCompleted(id, completed);
    },

    onSetTask: (id, isTask) => {
      capture(focusIndex.current, id);
      setIsTask(id, isTask);
    },

    onToggleCollapsed: (id, collapsed) => {
      capture(focusIndex.current, id);
      toggleCollapsed(id, collapsed);
    },

    onMoveFocus: (id, direction) => {
      const target = findVisibleNeighbor(
        focusIndex.current,
        rootIdRef.current,
        id,
        direction,
      );
      if (target) {
        const el = refs.current.get(target);
        if (el) {
          el.focus();
          placeCaretAtStart(el);
        }
      }
    },

    // Zooming in: the clicked node is the pivot (list item -> title).
    onZoom: (id) => navigateZoom(id, id),
  };

  // Top-level roots start the fade cascade fresh: a completed ancestor above
  // the current view (when zoomed) contributes nothing. Hide completed roots
  // when the toggle is off. See docs/adr/0002.
  const topLevel = childrenOf(index, rootId).filter(
    (n) => showCompleted || !n.completed,
  );
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
      <Header>
        <BreadcrumbTrail
          trail={trail}
          rootId={rootId || null}
          onNavigate={navigateZoom}
        />
      </Header>
      <div className="mx-auto max-w-[720px] p-6">
        {zoomedNode && (
          <ZoomedTitle
            node={zoomedNode}
            isPivot={pivotId === zoomedNode.id}
            registerRef={registerRef}
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

        <ul className="outline-list">
          {topLevel.map((node) => (
            <OutlineNode
              key={node.id}
              node={node}
              index={index}
              commands={commands}
              registerRef={registerRef}
              pivotId={pivotId}
              ancestorCompleted={false}
              showCompleted={showCompleted}
            />
          ))}
        </ul>
        {topLevel.length === 0 && (
          <div className="outline-empty">
            Empty. Click below to add your first bullet.
          </div>
        )}
        {/* Click anywhere in the whitespace below the list adds a new top-level bullet. */}
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          onClick={() => {
            const siblings = childrenOf(focusIndex.current, rootId);
            const afterId = siblings.length
              ? siblings[siblings.length - 1]!.id
              : null;
            const newId = insertSibling(focusIndex.current, rootId, afterId);
            pendingFocus.current = newId;
          }}
        >
          <PlusIcon />
        </Button>
      </div>
    </>
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
  onTextChange,
  onAddChild,
  onArrowDown,
}: {
  node: Node;
  isPivot: boolean;
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  onTextChange: (text: string) => void;
  onAddChild: () => void;
  onArrowDown: () => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.textContent !== node.text) {
      el.textContent = node.text;
    }
  });

  // Title shortcuts, scoped to the title's own contentEditable. Enter adds a
  // first child under the title; ArrowDown drops focus into the first child.
  useHotkeys(
    [
      { hotkey: "Enter", callback: () => onAddChild() },
      { hotkey: "ArrowDown", callback: () => onArrowDown() },
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
        role="textbox"
        aria-label="Title"
        data-completed={node.completed}
        onInput={(e) => onTextChange(e.currentTarget.textContent ?? "")}
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
 * The zoomed node and its ancestors, from the top of the outline down to
 * (and including) the zoomed node itself. Used to render the breadcrumb.
 */
function buildTrail(index: TreeIndex, rootId: string | null): Node[] {
  if (!rootId) return [];
  const trail: Node[] = [];
  let current = index.byId.get(rootId) ?? null;
  // Guard against corrupted parent chains.
  let guard = index.byId.size + 1;
  while (current && guard-- > 0) {
    trail.unshift(current);
    current = current.parentId
      ? (index.byId.get(current.parentId) ?? null)
      : null;
  }
  return trail;
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
): string | null {
  const flat = flattenVisible(index, rootId);
  const i = flat.findIndex((n) => n.id === id);
  if (i === -1) return null;
  const neighbor = direction === "up" ? flat[i - 1] : flat[i + 1];
  return neighbor ? neighbor.id : null;
}

function flattenVisible(
  index: TreeIndex,
  rootId: string | null,
): Array<{ id: string }> {
  const out: Array<{ id: string }> = [];
  // The zoomed title participates in up/down navigation.
  if (rootId) out.push({ id: rootId });
  const walk = (parentId: string | null) => {
    for (const child of childrenOf(index, parentId)) {
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
