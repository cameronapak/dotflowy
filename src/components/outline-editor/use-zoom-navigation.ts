import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { childrenOf, type Node, type TreeIndex } from "../../data/tree";
import { consumeFlashAfterNav, flashRow } from "../flash-node";
import { placeCaretAtEnd, prefersReducedMotion } from "./caret";
import { revealAncestorsToRoot } from "./reveal-ancestors";

interface ZoomNavigationArgs {
  index: TreeIndex;
  rootId: string | null;
  isHidden: (node: Node) => boolean;
  refs: RefObject<Map<string, HTMLSpanElement | null>>;
  focusIndex: RefObject<TreeIndex>;
  navigate: ReturnType<typeof useNavigate>;
}

/**
 * Zoom navigation: the shared-element morph between a node's title and list-item
 * roles, Cmd+, zoom-out, and the focus landing after a navigation. Returns the
 * stable `navigateZoom` and the current pivot id. The mount-only effects rely on
 * the editor remounting per zoom view (ADR 0003's `key={nodeId}`).
 */
export function useZoomNavigation({
  index,
  rootId,
  isHidden,
  refs,
  focusIndex,
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
  const pivotIdRef = useRef<string | null>(pivotId);
  pivotIdRef.current = pivotId;
  const rootIdRef = useRef<string | null>(rootId);
  rootIdRef.current = rootId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  /**
   * Navigate to a new zoom root with a shared-element morph. `pivot` is the
   * node that changes role: the target when zooming in (list item -> title),
   * the current root when zooming out (title -> list item). We name the pivot in
   * the OUTGOING view here; the incoming view names it declaratively.
   */
  const navigateZoom = useCallback(
    (toRootId: string | null, pivot: string) => {
      const navigate = navigateRef.current;
      // Zooming out reveals the trail: expand any collapsed ancestor between the
      // node we're leaving and the destination root, so the pivot is actually
      // visible when we land (otherwise a collapsed parent hides where you were).
      revealAncestorsToRoot(focusIndex.current, pivot, toRootId);
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
    [focusIndex, refs],
  );

  // Cmd/Ctrl+,: zoom out one level -- navigate to the current root's parent,
  // with the current root as the morph pivot (title -> list item). No-op at the
  // top. Mirror of Cmd+. (zoom in). Keyed off rootId, not the focused node.
  useHotkey(
    "Mod+,",
    () => {
      const currentRoot = rootIdRef.current;
      if (currentRoot === null) return;
      const node = focusIndex.current.byId.get(currentRoot);
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
