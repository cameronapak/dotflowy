import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { parseQuery, serializeQuery } from "../../data/tags";

type NavigateFn = ReturnType<typeof useNavigate>;

let navigateRef: NavigateFn | null = null;
let rootIdRef: string | null = null;

/** Binds live route writers for chip-click handlers outside React hooks. */
function bindTagFilterNav(navigate: NavigateFn, rootId: string | null) {
  navigateRef = navigate;
  rootIdRef = rootId;
}

function writeTags(tags: string[]) {
  if (!navigateRef) return;
  const q = serializeQuery(tags);
  const nextSearch = q ? { q } : {};
  const root = rootIdRef;
  if (root === null) navigateRef({ to: "/", search: nextSearch });
  else
    navigateRef({
      to: "/$nodeId",
      params: { nodeId: root },
      search: nextSearch,
    });
}

/** AND a tag into the active filter from a delegated chip click (Seam B). */
export function addTagToFilter(tag: string) {
  const current = parseQuery(
    new URLSearchParams(window.location.search).get("q") ?? undefined,
  );
  if (current.includes(tag)) return;
  writeTags([...current, tag]);
}

export function useTagFilter() {
  const params = useParams({ strict: false });
  const rootId = params.nodeId ?? null;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { q?: string };
  const activeTags = useMemo(() => parseQuery(search.q), [search.q]);
  const activeTagsRef = useRef(activeTags);
  activeTagsRef.current = activeTags;

  useEffect(() => {
    bindTagFilterNav(navigate, rootId);
  }, [navigate, rootId]);

  const setQ = useCallback((tags: string[]) => {
    writeTags(tags);
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
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.classList.contains("node-text")
      )
        return;
      clearTags();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTags.length, clearTags]);

  return { activeTags, addTag, removeTag, clearTags };
}
