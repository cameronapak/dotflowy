import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { useNavigate, useSearchParams } from "react-router";
import { parseQuery, serializeQuery } from "../../plugins/tags/tags";

type NavigateFn = ReturnType<typeof useNavigate>;

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
  navigate: NavigateFn,
): TagFilterControls {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? undefined;
  const activeTags = useMemo(() => parseQuery(q), [q]);
  const activeTagsRef = useRef(activeTags);
  activeTagsRef.current = activeTags;
  const rootIdRef = useRef<string | null>(rootId);
  rootIdRef.current = rootId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const setQ = useCallback((tags: string[]) => {
    const serialized = serializeQuery(tags);
    const search = serialized
      ? `?${new URLSearchParams({ q: serialized }).toString()}`
      : "";
    const root = rootIdRef.current;
    const pathname =
      root === null ? "/" : `/${encodeURIComponent(root)}`;
    navigateRef.current({ pathname, search });
  }, []);

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

  useEffect(() => {
    if (activeTags.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
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
