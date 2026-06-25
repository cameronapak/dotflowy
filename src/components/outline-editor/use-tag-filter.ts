import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { parseQuery, serializeQuery } from "../../data/tags";

export interface TagFilterControls {
  activeTags: string[];
  activeTagsRef: RefObject<string[]>;
  addTag: (tag: string) => void;
  removeTag: (tag: string) => void;
  clearTags: () => void;
  setQ: (tags: string[]) => void;
}

/**
 * The URL-driven tag filter (?q=, ADR 0015): the active tags read from the
 * search param, plus the stable handlers that write them. Self-contained -- it
 * keeps its own live rootId/navigate refs so the handlers never re-bind.
 */
export function useTagFilter(
  rootId: string | null,
  navigate: ReturnType<typeof useNavigate>,
): TagFilterControls {
  const search = useSearch({ strict: false }) as { q?: string };
  const activeTags = useMemo(() => parseQuery(search.q), [search.q]);
  const activeTagsRef = useRef(activeTags);
  activeTagsRef.current = activeTags;
  const rootIdRef = useRef<string | null>(rootId);
  rootIdRef.current = rootId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Write the active tags into the `q` param on the current route. Stable
  // (reads live values through refs), so the chip-click handler and filter bar
  // never re-bind.
  const setQ = useCallback((tags: string[]) => {
    const q = serializeQuery(tags);
    const nextSearch = q ? { q } : {};
    const root = rootIdRef.current;
    if (root === null) navigateRef.current({ to: "/", search: nextSearch });
    else
      navigateRef.current({
        to: "/$nodeId",
        params: { nodeId: root },
        search: nextSearch,
      });
  }, []);
  // Clicking a tag AND-s it into the filter (accretes, never replaces); a
  // pill's ✕ drops one; clear-all drops the filter.
  const addTag = useCallback(
    (tag: string) => {
      const current = activeTagsRef.current;
      if (current.includes(tag)) return;
      setQ([...current, tag]);
    },
    [setQ],
  );
  const removeTag = useCallback(
    (tag: string) => setQ(activeTagsRef.current.filter((t) => t !== tag)),
    [setQ],
  );
  const clearTags = useCallback(() => setQ([]), [setQ]);

  // Escape clears the filter -- but only when the caret isn't inside a bullet,
  // so it never eats an in-progress edit (ADR 0015).
  useEffect(() => {
    if (activeTags.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.classList.contains("node-text"))
        return;
      clearTags();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTags.length, clearTags]);

  return { activeTags, activeTagsRef, addTag, removeTag, clearTags, setQ };
}
