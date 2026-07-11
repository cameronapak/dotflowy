import type { useNavigate } from "@tanstack/react-router";

import { tokenizeQuery } from "../data/filter-query";

// The `?q=` filter is CORE chrome now (the query grammar, ADR 0047 §6). This
// module holds the route writers + the summon-opener singleton so surfaces
// OUTSIDE the React tree (a tags-plugin chip click, the Cmd+F hotkey, the Cmd+K
// "Filter this view" action) can drive the filter without a hook. The React
// half (the hook + the bar/input UI) lives in `query-filter.tsx`, which binds
// these on mount.

type NavigateFn = ReturnType<typeof useNavigate>;

let navigateRef: NavigateFn | null = null;
let rootIdRef: string | null = null;

/** Bind live route writers for handlers that run outside React hooks. Called by
 *  `useQueryFilter` in an effect. */
export function bindQueryFilterNav(
  navigate: NavigateFn,
  rootId: string | null,
) {
  navigateRef = navigate;
  rootIdRef = rootId;
}

/** Write a raw `?q=` string (empty = drop the param), zoom-scoped to the current
 *  root. `replace` avoids spamming history on live-as-you-type edits. */
export function writeQuery(q: string, opts?: { replace?: boolean }) {
  if (!navigateRef) return;
  const trimmed = q.trim();
  const nextSearch = trimmed ? { q: trimmed } : {};
  const replace = opts?.replace ?? false;
  const root = rootIdRef;
  if (root === null) navigateRef({ to: "/", search: nextSearch, replace });
  else
    navigateRef({
      to: "/$nodeId",
      params: { nodeId: root },
      search: nextSearch,
      replace,
    });
}

/** Write the query from a token list (the tag-chip AND-in dedup path). */
export function writeQueryTokens(tokens: string[]) {
  writeQuery(tokens.join(" "));
}

/** AND a term (a `#tag`, `is:todo`, ...) into the active filter, deduped against
 *  the surface tokens already in `?q=`. Used by the tags plugin's chip click
 *  (Seam B) -- the plugin only knows "add this term", the grammar is core. */
export function addTermToFilter(term: string) {
  const current = tokenizeQuery(
    new URLSearchParams(window.location.search).get("q") ?? undefined,
  );
  if (current.includes(term)) return;
  writeQueryTokens([...current, term]);
}

// --- The summon-input opener singleton --------------------------------------

let opener: (() => void) | null = null;

/** Registered by `QueryFilterBar` so Cmd+F / the header magnifier / the Cmd+K
 *  action can summon the filter input from anywhere. */
export function setFilterInputOpener(fn: (() => void) | null) {
  opener = fn;
}

/** Summon the filter input (focused, prefilled if a filter is active). */
export function openFilterInput() {
  opener?.();
}
