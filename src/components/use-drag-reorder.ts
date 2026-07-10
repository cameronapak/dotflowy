import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { isMirrorsEnabled } from "../data/flags";
import { type Node, type TreeIndex } from "../data/tree";
import { isVirtualNavActive, virtualRowRect } from "../data/virtual-nav";
import {
  buildVisibleRows,
  instanceIdForKey,
  parentKeyOf,
} from "../data/visible-order";
import { INDENT_PX } from "./OutlineRow";

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
// Indent per depth level. The render's single source (OutlineRow.INDENT_PX, also
// the recursive path's `.outline-children` padding); measured from the live rows
// when possible, this is the fallback so the windowed drop-depth projection can't
// drift from the rendered indent.
const INDENT_FALLBACK = INDENT_PX;
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
  // The render ADDRESS (row.key) -- the drag's identity, so a windowed source
  // descendant inside a mirror is the exact on-screen row, not its source copy
  // (ADR 0022). Equals `id` for every mirror-free row, so the 99% path is
  // unchanged. Geometry (virtualRowRect) and the refs lookup both key off this.
  key: string;
  // The INSTANCE (position) node id -- what `moveNode` repositions. Inside a
  // mirror's window this is the real node (instance === content), so reordering
  // it restructures the source and shows in every instance.
  id: string;
  // The CONTENT node id (`mirrorOf ?? id`). Used when this row is the drop
  // PARENT: dropping under a mirror targets its SOURCE, so the new child windows
  // into every instance (the ADR 0022 field split, applied in onMove).
  contentId: string;
  // The RENDER parent's instance id (`instanceIdForKey(parentKeyOf(key))`), not
  // the tree parent: inside a mirror a windowed child's render parent is the
  // mirror instance, so the sibling/ancestor projection stays within the window.
  // Field-split back to a content id in onMove. Equals the tree parent off-flag.
  parentId: string | null;
  depth: number; // relative to the zoom root: its direct children are depth 0
  el: HTMLElement | null;
}

// A row's viewport box for hit-testing. Sourced from a DOMRect (recursive path)
// or synthesized from the virtualizer's measurements (windowed path).
interface RowRect {
  top: number;
  bottom: number;
  height: number;
  left: number;
  right: number;
}

interface DragDeps {
  getIndex: () => TreeIndex;
  getRootId: () => string | null;
  /** The composed Seam-G visibility prune (hide-completed today). Drag mirrors
   *  the render: a hidden node is not a droppable row. See ADR 0001. */
  getIsHidden: () => (node: Node) => boolean;
  /** The `.outline-row` element for a row KEY (via the editor's refs registry,
   *  keyed by row.key since ADR 0022; key === id off the flag). */
  getRowEl: (key: string) => HTMLElement | null;
  /** The `ul.outline-list` element, for the indicator's right edge. */
  getListEl: () => HTMLElement | null;
  /**
   * Commit the drop. `grabbedKey` is the dragged row's render address; the parent
   * + predecessor are INSTANCE ids from the render hierarchy. The editor resolves
   * the field split (a drop under a mirror targets its source) and re-derives the
   * landing focus key from the post-move render walk. Off the flag these are bare
   * ids and the resolution is a no-op.
   */
  onMove: (
    grabbedKey: string,
    newParentInstanceId: string | null,
    afterSiblingInstanceId: string | null,
  ) => void;
}

interface DragState {
  /** The grabbed row's KEY (render address) -- buildRows/getRowEl/onMove all key
   *  off it. Equals the node id for every mirror-free drag. */
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
  // excluding the grabbed row and everything under it (can't drop into self).
  //
  // Reuses `buildVisibleRows` -- the SAME flat walk the editor renders and the
  // virtualizer indexes -- so the drag's rows can't drift from what's on screen
  // (inside a mirror the ad-hoc tree walk produced the wrong rows: it never
  // resolved the windowed source descendants, so their geometry was missing and
  // the drop line projected off only the non-mirror rows). The grabbed subtree
  // is the CONTIGUOUS run of deeper rows right after the grabbed one -- the flat
  // list's standard subtree property, uniform across mirror-free and crossed
  // paths. Filter is null to match today's drag (it ignores the tag filter).
  const buildRows = useCallback((grabbedKey: string): Row[] => {
    const { getIndex, getRootId, getIsHidden, getRowEl } = depsRef.current;
    const index = getIndex();
    const rootId = getRootId();
    const isHidden = getIsHidden();
    const visible = buildVisibleRows(
      index,
      rootId,
      isHidden,
      null,
      isMirrorsEnabled(),
    );

    // The grabbed row, then skip it + its rendered subtree (rows deeper than it,
    // up to the next row at or above its depth).
    const gi = visible.findIndex((r) => r.key === grabbedKey);
    let skipEnd = gi;
    if (gi !== -1) {
      const grabbedDepth = visible[gi]!.depth;
      skipEnd = gi + 1;
      while (
        skipEnd < visible.length &&
        visible[skipEnd]!.depth > grabbedDepth
      ) {
        skipEnd++;
      }
    }

    const rows: Row[] = [];
    for (let i = 0; i < visible.length; i++) {
      if (gi !== -1 && i >= gi && i < skipEnd) continue;
      const vr = visible[i]!;
      const parentKey = parentKeyOf(vr.key);
      rows.push({
        key: vr.key,
        id: vr.id,
        contentId: vr.contentId,
        // Render parent: the mirror/ancestor instance the row sits under, or the
        // node's tree parent at the top level (key === id, parentKey === null).
        parentId: parentKey
          ? instanceIdForKey(parentKey)
          : (index.byId.get(vr.id)?.parentId ?? null),
        depth: vr.depth,
        el: getRowEl(vr.key),
      });
    }
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
    const text =
      index.byId.get(instanceIdForKey(s.id))?.text?.trim() || "Untitled";

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
    // Geometry source: the virtualizer's measurements when windowed (so an
    // off-screen drop target still has a position, estimated until it renders),
    // else the rendered rows' DOM rects (recursive path). The depth math after
    // is identical -- only where top/left come from differs.
    const virtualized = isVirtualNavActive();
    const listEl = depsRef.current.getListEl();
    const listRect = listEl?.getBoundingClientRect();
    const scrollY = window.scrollY;
    const pairs: { row: Row; rect: RowRect }[] = [];
    for (const r of s.rows) {
      if (virtualized) {
        const vr = virtualRowRect(r.key, scrollY);
        if (!vr) continue;
        // Uniform indent: depth-0 left is the container left; deeper rows add
        // depth * indent (OutlineRow's paddingInlineStart). project() backs
        // baseLeft out of this exactly, so the synthesized left is self-consistent.
        const left = (listRect?.left ?? 0) + r.depth * s.indent;
        pairs.push({
          row: r,
          rect: {
            top: vr.top,
            bottom: vr.top + vr.height,
            height: vr.height,
            left,
            right: listRect?.right ?? left + 240,
          },
        });
      } else if (r.el) {
        const b = r.el.getBoundingClientRect();
        pairs.push({
          row: r,
          rect: {
            top: b.top,
            bottom: b.bottom,
            height: b.height,
            left: b.left,
            right: b.right,
          },
        });
      }
    }
    const rows = pairs.map((p) => p.row);
    const rects = pairs.map((p) => p.rect);

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

    // Indicator: a line at the gap, indented to the target depth. listEl/listRect
    // were resolved above (shared with the geometry source).
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
      const grabbedKey = s.id;
      cleanup();
      if (pending) {
        depsRef.current.onMove(
          grabbedKey,
          pending.parentId,
          pending.afterSiblingId,
        );
      }
      return;
    }
    cleanup();
  }

  const startDrag = useCallback(
    (grabbedKey: string, e: ReactPointerEvent) => {
      // A fresh press: clear any stale click-suppression.
      consumed.current = false;
      // Ignore secondary buttons.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      state.current = {
        id: grabbedKey,
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
    // startDrag must stay referentially stable (it rides in the memoized
    // commands, ADR 0014). onMove/onUp are recreated each render but read only
    // refs (state.current, depsRef.current), so the mount-render closures behave
    // identically; cleanup removes the exact stored references. Adding them
    // would churn startDrag for zero correctness gain.
    // eslint-disable-next-line react-doctor/exhaustive-deps
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

  // Unmount teardown. `cleanup` is otherwise only reached via `onUp`
  // (pointerup/cancel); if this component unmounts mid-drag (the windowed source
  // row scrolls out, a zoom/route change, a big sync re-render), the document
  // pointer listeners + rAF loop + injected pill/indicator + `dragging-active`
  // body class would all leak. An empty-dep effect whose cleanup runs only on
  // unmount removes exactly that. cleanup() self-guards on a null drag, so this
  // is a no-op when nothing is in flight. cleanup is stable ([] deps).
  useEffect(() => cleanup, [cleanup]);

  return { startDrag, consumeClick };
}
