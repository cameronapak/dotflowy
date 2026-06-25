import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { parseQuery, serializeQuery } from "../../data/tags";

type NavigateFn = ReturnType<typeof useNavigate>;

let navigateRef: NavigateFn | null = null;
let rootIdRef: string | null = null;

/** Binds live route writers for chip-click handlers outside React hooks. */
export function bindTagFilterNav(navigate: NavigateFn, rootId: string | null) {
  navigateRef = navigate;
  rootIdRef = rootId;
}

function writeTags(tags: string[]) {
  if (!navigateRef) return;
  const q = serializeQuery(tags);
  const search = q ? `?${new URLSearchParams({ q }).toString()}` : "";
  const root = rootIdRef;
  const pathname = root === null ? "/" : `/${encodeURIComponent(root)}`;
  navigateRef({ pathname, search });
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
  const params = useParams();
  const rootId = params.nodeId ?? null;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? undefined;
  const activeTags = useMemo(() => parseQuery(q), [q]);
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
      if (active instanceof HTMLElement && active.classList.contains("node-text"))
        return;
      clearTags();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTags.length, clearTags]);

  return { activeTags, addTag, removeTag, clearTags };
}
