import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRight, MoreHorizontal, PlusIcon } from "lucide-react";
import { useTree } from "../data/useTree";
import { childrenOf, type Node, type TreeIndex } from "../data/tree";
import {
  indent,
  insertChildAtStart,
  insertSibling,
  outdent,
  removeNode,
  setText,
  toggleCollapsed,
  toggleCompleted,
} from "../data/mutations";
import { seedIfEmpty } from "../data/seed";
import { OutlineNode, type NodeCommands } from "./OutlineNode";

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
        ? localStorage.getItem("workflowy-oss:nodes")
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
    onTextChange: (id, text) => setText(id, text),

    onEnter: (id) => {
      const node = focusIndex.current.byId.get(id);
      if (!node) return;
      const newId = insertSibling(focusIndex.current, node.parentId, id);
      pendingFocus.current = newId;
    },

    onIndent: (id) => {
      indent(focusIndex.current, id);
    },

    onOutdent: (id) => {
      // Don't let a direct child of the zoom root outdent past it; that
      // would move it out of the visible subtree and look like it vanished.
      const node = focusIndex.current.byId.get(id);
      if (node && node.parentId === rootIdRef.current) return;
      outdent(focusIndex.current, id);
    },

    onDeleteEmpty: (id) => {
      const focusId = removeNode(focusIndex.current, id);
      if (focusId) pendingFocus.current = focusId;
    },

    onToggleCompleted: (id, completed) => toggleCompleted(id, completed),

    onToggleCollapsed: (id, collapsed) => toggleCollapsed(id, collapsed),

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

  const topLevel = childrenOf(index, rootId);
  const zoomedNode = rootId ? (index.byId.get(rootId) ?? null) : null;
  const trail = buildTrail(index, rootId);

  // Deep-linked to a node that no longer exists (and the store has loaded).
  if (rootId !== null && zoomedNode === null && index.byId.size > 0) {
    return (
      <div className="outline-root">
        <div className="outline-empty">
          That bullet doesn't exist. <Link to="/">Back to top</Link>.
        </div>
      </div>
    );
  }

  return (
    <div className="outline-root">
      {rootId !== null && (
        <BreadcrumbTrail
          trail={trail}
          rootId={rootId}
          onNavigate={navigateZoom}
        />
      )}

      {zoomedNode && (
        <ZoomedTitle
          node={zoomedNode}
          isPivot={pivotId === zoomedNode.id}
          registerRef={registerRef}
          onTextChange={(text) => setText(zoomedNode.id, text)}
          onAddChild={() => {
            const newId = insertChildAtStart(focusIndex.current, zoomedNode.id);
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
          />
        ))}
      </ul>
      {topLevel.length === 0 && (
        <div className="outline-empty">
          Empty. Click below to add your first bullet.
        </div>
      )}
      {/* Click anywhere in the whitespace below the list adds a new top-level bullet. */}
      <button
        type="button"
        className="add-top"
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
      </button>
    </div>
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

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onAddChild();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onArrowDown();
    }
  };

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
        onKeyDown={handleKeyDown}
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
const TRAILING = 1;

function BreadcrumbTrail({
  trail,
  rootId,
  onNavigate,
}: {
  trail: Node[];
  rootId: string;
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
      <button
        type="button"
        className="crumb-link"
        onClick={() => onNavigate(null, rootId)}
      >
        Home
      </button>
      {lead.map((ancestor) => (
        <Crumb
          key={ancestor.id}
          ancestor={ancestor}
          rootId={rootId}
          onNavigate={onNavigate}
        />
      ))}
      {collapse && (
        <CollapsedCrumbs
          hidden={hidden}
          rootId={rootId}
          onNavigate={onNavigate}
        />
      )}
      {tail.map((ancestor) => (
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
 * Ancestors of the zoomed node, from the top of the outline down to (but
 * not including) the zoomed node itself. Used to render the breadcrumb.
 */
function buildTrail(index: TreeIndex, rootId: string | null): Node[] {
  if (!rootId) return [];
  const trail: Node[] = [];
  let parentId = index.byId.get(rootId)?.parentId ?? null;
  // Guard against corrupted parent chains.
  let guard = index.byId.size + 1;
  while (parentId && guard-- > 0) {
    const parent = index.byId.get(parentId);
    if (!parent) break;
    trail.unshift(parent);
    parentId = parent.parentId;
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
