import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { childrenOf, type Node, type TreeIndex } from "../data/tree";

/**
 * Pointer-driven drag to reorder and reparent a bullet, for mouse and touch.
 * Drives the gesture imperatively (no React state on the hot path): on each
 * pointermove it measures the rendered rows, resolves the drop to a parent +
 * predecessor, and positions a floating pill and a drop indicator directly in
 * the DOM. The single `moveNode` call happens on release. See ADR 0010.
 *
 * The whole feature hangs off the bullet dot, which already zooms on click:
 * `startDrag` arms a movement threshold on pointerdown, and `consumeClick`
 * lets the dot's click handler tell a real drag apart from a plain click (only
 * the latter should zoom).
 */

// Movement (px) before a press becomes a drag. Below this, it's a click → zoom.
const THRESHOLD = 5;
// Indent per depth level. Matches `.outline-children { padding-left }` in
// styles.css; measured from the live rows when possible, this is the fallback.
const INDENT_FALLBACK = 24;
// How much of an indent the pointer must travel rightward before a drop nests
// one level deeper. 0 = snap to the nearest level (flips at the halfway point);
// higher = stickier toward the shallower level, so a near-vertical drag stays
// at sibling depth instead of slipping under the row above. 0.4 means you cross
// ~90% of an indent to nest. Tunable feel knob. See ADR 0010.
const NEST_RESISTANCE = 0.4;
// Distance from a viewport edge (px) that triggers auto-scroll while dragging.
const EDGE = 72;
// Max auto-scroll speed (px per frame) at the very edge.
const SCROLL_MAX = 18;

interface Row {
  id: string;
  parentId: string | null;
  depth: number; // relative to the zoom root: its direct children are depth 0
  el: HTMLElement | null;
}

interface DragDeps {
  getIndex: () => TreeIndex;
  getRootId: () => string | null;
  /** The composed Seam-G visibility prune (hide-completed today). Drag mirrors
   *  the render: a hidden node is not a droppable row. See ADR 0018. */
  getIsHidden: () => (node: Node) => boolean;
  /** The `.outline-row` element for a node id (via the editor's refs registry). */
  getRowEl: (id: string) => HTMLElement | null;
  /** The `ul.outline-list` element, for the indicator's right edge. */
  getListEl: () => HTMLElement | null;
  onMove: (
    id: string,
    newParentId: string | null,
    afterSiblingId: string | null,
  ) => void;
}

interface DragState {
  id: string;
  startX: number;
  startY: number;
  dragging: boolean;
  rows: Row[]; // visible rows excluding the grabbed node + its subtree
  indent: number;
  lastX: number;
  lastY: number;
  pending: { parentId: string | null; afterSiblingId: string | null } | null;
  indicator: HTMLElement | null;
  pill: HTMLElement | null;
  raf: number | null;
  // The exact listener instances registered for this drag, so cleanup removes
  // the same references even if the component re-rendered mid-drag.
  moveHandler: (e: PointerEvent) => void;
  upHandler: () => void;
}

export function useDragReorder(deps: DragDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const state = useRef<DragState | null>(null);
  // Set on a real drag so the dot's click (which follows pointerup) skips zoom.
  const consumed = useRef(false);

  const cleanup = useCallback(() => {
    const s = state.current;
    if (!s) return;
    if (s.raf != null) cancelAnimationFrame(s.raf);
    s.indicator?.remove();
    s.pill?.remove();
    const sourceRow = depsRef.current.getRowEl(s.id);
    sourceRow?.classList.remove("drag-source");
    sourceRow?.closest(".outline-node")?.classList.remove("drag-collapsed");
    document.body.classList.remove("dragging-active");
    document.removeEventListener("pointermove", s.moveHandler);
    document.removeEventListener("pointerup", s.upHandler);
    document.removeEventListener("pointercancel", s.upHandler);
    state.current = null;
  }, []);

  // Build the visible, ordered rows (matching what's rendered), with depth,
  // excluding the grabbed node and everything under it (can't drop into self).
  const buildRows = useCallback((grabbedId: string): Row[] => {
    const { getIndex, getRootId, getIsHidden, getRowEl } = depsRef.current;
    const index = getIndex();
    const rootId = getRootId();
    const isHidden = getIsHidden();

    const skip = new Set<string>([grabbedId]);
    const stack = [grabbedId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const c of childrenOf(index, id)) {
        skip.add(c.id);
        stack.push(c.id);
      }
    }

    const rows: Row[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const child of childrenOf(index, parentId)) {
        if (isHidden(child)) continue;
        if (!skip.has(child.id)) {
          rows.push({
            id: child.id,
            parentId: child.parentId,
            depth,
            el: getRowEl(child.id),
          });
        }
        // Descend regardless of skip: a non-skipped node can't live under a
        // skipped (grabbed) one, so this only walks real visible structure.
        if (!child.collapsed && !skip.has(child.id)) walk(child.id, depth + 1);
      }
    };
    walk(rootId, 0);
    return rows;
  }, []);

  const beginDrag = useCallback(() => {
    const s = state.current;
    if (!s) return;
    s.dragging = true;
    s.rows = buildRows(s.id);

    // Derive the per-level indent from two rows at different depths; fall back
    // to the CSS constant when the list is too shallow to measure.
    s.indent = INDENT_FALLBACK;
    const a = s.rows.find((r) => r.el);
    const b = s.rows.find((r) => r.el && r.depth !== a?.depth);
    if (a?.el && b?.el && a.depth !== b.depth) {
      const la = a.el.getBoundingClientRect().left;
      const lb = b.el.getBoundingClientRect().left;
      s.indent = Math.abs((la - lb) / (a.depth - b.depth)) || INDENT_FALLBACK;
    }

    const sourceRow = depsRef.current.getRowEl(s.id);
    sourceRow?.classList.add("drag-source");
    // Visually collapse the grabbed subtree so we carry one compact row.
    sourceRow?.closest(".outline-node")?.classList.add("drag-collapsed");

    const index = depsRef.current.getIndex();
    const text = index.byId.get(s.id)?.text?.trim() || "Untitled";

    const pill = document.createElement("div");
    pill.className = "drag-pill";
    pill.textContent = text;
    document.body.appendChild(pill);
    s.pill = pill;

    const indicator = document.createElement("div");
    indicator.className = "drag-indicator";
    document.body.appendChild(indicator);
    s.indicator = indicator;

    document.body.classList.add("dragging-active");
  }, [buildRows]);

  // Resolve the pointer position to a drop gap + target depth, position the
  // indicator and pill, and stash the pending (parent, predecessor).
  const project = useCallback((px: number, py: number) => {
    const s = state.current;
    if (!s) return;
    const rows = s.rows.filter((r) => r.el);
    const rects = rows.map((r) => r.el!.getBoundingClientRect());

    // Gap: index of the first row whose vertical midpoint is below the pointer.
    let gap = rows.length;
    for (let i = 0; i < rows.length; i++) {
      if (py < rects[i]!.top + rects[i]!.height / 2) {
        gap = i;
        break;
      }
    }
    const above = gap > 0 ? rows[gap - 1]! : null;
    const aboveRect = gap > 0 ? rects[gap - 1]! : null;
    const below = gap < rows.length ? rows[gap]! : null;
    const belowRect = gap < rows.length ? rects[gap]! : null;

    // Legal depth range at this gap: as deep as a child of the row above, as
    // shallow as the row below (or top-level). 0 = direct child of the zoom
    // root, so the lower bound also keeps the node inside the current view.
    const maxDepth = above ? above.depth + 1 : 0;
    const minDepth = below ? below.depth : 0;

    // Base x of depth 0, backed out from a known row, then depth from pointer x.
    const ref = above ?? below;
    const refRect = aboveRect ?? belowRect;
    const baseLeft = ref && refRect ? refRect.left - ref.depth * s.indent : 0;
    // Subtract NEST_RESISTANCE so gaining depth needs deliberate rightward
    // travel; shedding depth (moving left) stays easy.
    const desired = Math.round((px - baseLeft) / s.indent - NEST_RESISTANCE);
    const depth = Math.max(minDepth, Math.min(maxDepth, desired));

    // Parent + predecessor for `depth` at this gap.
    let parentId: string | null;
    if (depth === 0 || !above) {
      parentId = depsRef.current.getRootId();
    } else if (depth === above.depth + 1) {
      parentId = above.id; // become the row above's (last/only) child
    } else if (depth === above.depth) {
      parentId = above.parentId; // sibling of the row above
    } else {
      // Shallower than the row above: adopt the nearest ancestor at this depth.
      let found: string | null = depsRef.current.getRootId();
      for (let i = gap - 1; i >= 0; i--) {
        if (rows[i]!.depth === depth) {
          found = rows[i]!.parentId;
          break;
        }
        if (rows[i]!.depth < depth) break;
      }
      parentId = found;
    }

    // Predecessor: nearest row above the gap at exactly `depth` under `parentId`.
    // Stop if we drop below `depth` first — then we're the first child (null).
    let afterSiblingId: string | null = null;
    for (let i = gap - 1; i >= 0; i--) {
      if (rows[i]!.depth < depth) break;
      if (rows[i]!.depth === depth && rows[i]!.parentId === parentId) {
        afterSiblingId = rows[i]!.id;
        break;
      }
    }

    s.pending = { parentId, afterSiblingId };

    // Indicator: a line at the gap, indented to the target depth.
    const listEl = depsRef.current.getListEl();
    const listRect = listEl?.getBoundingClientRect();
    const y = aboveRect
      ? aboveRect.bottom
      : belowRect
        ? belowRect.top
        : (listRect?.top ?? py);
    const left = baseLeft + depth * s.indent;
    const right = listRect?.right ?? left + 240;
    if (s.indicator) {
      s.indicator.style.top = `${y}px`;
      s.indicator.style.left = `${left}px`;
      s.indicator.style.width = `${Math.max(40, right - left)}px`;
    }
    if (s.pill) {
      s.pill.style.left = `${px + 12}px`;
      s.pill.style.top = `${py + 12}px`;
    }
  }, []);

  // Auto-scroll loop: while the pointer sits in a top/bottom edge band, scroll
  // the window and re-project so off-screen drop targets become reachable.
  const tickScroll = useCallback(() => {
    const s = state.current;
    if (!s || !s.dragging) return;
    const y = s.lastY;
    const h = window.innerHeight;
    let dy = 0;
    if (y < EDGE) dy = -SCROLL_MAX * (1 - y / EDGE);
    else if (y > h - EDGE) dy = SCROLL_MAX * (1 - (h - y) / EDGE);
    if (dy !== 0) {
      window.scrollBy(0, dy);
      project(s.lastX, s.lastY);
    }
    s.raf = requestAnimationFrame(tickScroll);
  }, [project]);

  function onMove(e: PointerEvent) {
    const s = state.current;
    if (!s) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    if (!s.dragging) {
      const moved = Math.hypot(e.clientX - s.startX, e.clientY - s.startY);
      if (moved < THRESHOLD) return;
      beginDrag();
      s.raf = requestAnimationFrame(tickScroll);
    }
    e.preventDefault();
    project(e.clientX, e.clientY);
  }

  function onUp() {
    const s = state.current;
    if (!s) return;
    if (s.dragging) {
      consumed.current = true;
      const pending = s.pending;
      const id = s.id;
      cleanup();
      if (pending) {
        depsRef.current.onMove(id, pending.parentId, pending.afterSiblingId);
      }
      return;
    }
    cleanup();
  }

  const startDrag = useCallback(
    (id: string, e: ReactPointerEvent) => {
      // A fresh press: clear any stale click-suppression.
      consumed.current = false;
      // Ignore secondary buttons.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      state.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        rows: [],
        indent: INDENT_FALLBACK,
        lastX: e.clientX,
        lastY: e.clientY,
        pending: null,
        indicator: null,
        pill: null,
        raf: null,
        moveHandler: onMove,
        upHandler: onUp,
      };
      document.addEventListener("pointermove", onMove, { passive: false });
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [],
  );

  // True when the click that follows pointerup came from a real drag and should
  // be swallowed (no zoom). Resets itself so the next genuine click zooms.
  const consumeClick = useCallback(() => {
    if (consumed.current) {
      consumed.current = false;
      return true;
    }
    return false;
  }, []);

  return { startDrag, consumeClick };
}
