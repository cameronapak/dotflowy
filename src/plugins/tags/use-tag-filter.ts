import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { tokenizeQuery } from "../../data/filter-query";

// The `?q=` grammar is core now (ADR 0047), so the filter bar operates on the
// query's SURFACE TOKENS (`#tag`, `is:todo`, `"a phrase"`, `OR`, ...), not just
// tags. Removing one pill drops exactly one token and re-joins the rest -- so a
// non-tag term in `?q=` is preserved when a tag pill is removed, and Clear wipes
// the whole query. Chip-click still ANDs a `#tag`; the richer compose UI is a
// later slice.

type NavigateFn = ReturnType<typeof useNavigate>;

let navigateRef: NavigateFn | null = null;
let rootIdRef: string | null = null;

/** Binds live route writers for chip-click handlers outside React hooks. */
function bindTagFilterNav(navigate: NavigateFn, rootId: string | null) {
  navigateRef = navigate;
  rootIdRef = rootId;
}

function writeTokens(tokens: string[]) {
  if (!navigateRef) return;
  const q = tokens.join(" ");
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

/** AND a `#tag` into the active filter from a delegated chip click (Seam B).
 *  Dedupes against the surface tokens already in `?q=`, preserving every other
 *  term. */
export function addTagToFilter(tag: string) {
  const current = tokenizeQuery(
    new URLSearchParams(window.location.search).get("q") ?? undefined,
  );
  if (current.includes(tag)) return;
  writeTokens([...current, tag]);
}

export function useTagFilter() {
  const params = useParams({ strict: false });
  const rootId = params.nodeId ?? null;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { q?: string };
  const tokens = useMemo(() => tokenizeQuery(search.q), [search.q]);
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;

  useEffect(() => {
    bindTagFilterNav(navigate, rootId);
  }, [navigate, rootId]);

  const removeToken = useCallback((token: string) => {
    // Drop only the FIRST occurrence, so duplicate literals stay addressable.
    const current = tokensRef.current;
    const i = current.indexOf(token);
    if (i === -1) return;
    writeTokens([...current.slice(0, i), ...current.slice(i + 1)]);
  }, []);

  const clear = useCallback(() => writeTokens([]), []);

  useEffect(() => {
    if (tokens.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.classList.contains("node-text")
      )
        return;
      clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tokens.length, clear]);

  return { tokens, removeToken, clear };
}
