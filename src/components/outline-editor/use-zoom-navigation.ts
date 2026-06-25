import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useLocation, useNavigate } from "react-router";
import { childrenOf, type Node, type TreeIndex } from "../../data/tree";
import { consumeFlashAfterNav, flashRow } from "../flash-node";
import { placeCaretAtEnd, prefersReducedMotion } from "./caret";
import { revealAncestorsToRoot } from "./reveal-ancestors";

type NavigateFn = ReturnType<typeof useNavigate>;

type ZoomHistoryState = { pivotId?: string };

interface ZoomNavigationArgs {
  index: TreeIndex;
  rootId: string | null;
  isHidden: (node: Node) => boolean;
  refs: RefObject<Map<string, HTMLSpanElement | null>>;
  focusIndex: RefObject<TreeIndex>;
  navigate: NavigateFn;
}

/** React Router has no typed `viewTransition.types` — wrap navigate so zoom CSS activates. */
function navigateWithZoomTransition(
  navigate: NavigateFn,
  to: string,
  state: ZoomHistoryState,
) {
  const go = () => navigate(to, { state });
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function"
  ) {
    go();
    return;
  }
  document.startViewTransition({ update: go, types: ["zoom"] });
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
  const location = useLocation();
  const state = (location.state ?? {}) as ZoomHistoryState;
  const pivotId = state.pivotId ?? null;
  const pivotIdRef = useRef<string | null>(pivotId);
  pivotIdRef.current = pivotId;
  const rootIdRef = useRef<string | null>(rootId);
  rootIdRef.current = rootId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const navigateZoom = useCallback(
    (toRootId: string | null, pivot: string) => {
      const navigate = navigateRef.current;
      revealAncestorsToRoot(focusIndex.current, pivot, toRootId);
      const nextState = { pivotId: pivot };
      const to =
        toRootId === null
          ? "/"
          : `/${encodeURIComponent(toRootId)}`;
      if (prefersReducedMotion()) {
        navigate(to, { state: nextState });
        return;
      }
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
      navigateWithZoomTransition(navigate, to, nextState);
    },
    [focusIndex, refs],
  );

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
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, []);

  useEffect(() => {
    const flashId = consumeFlashAfterNav();
    if (!flashId) return;
    const el = refs.current.get(flashId);
    if (!el) return;
    el.focus({ preventScroll: true });
    placeCaretAtEnd(el);
    el.scrollIntoView({ block: "nearest" });
    flashRow(el.closest(".outline-row"));
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, []);

  return { navigateZoom, pivotId };
}
