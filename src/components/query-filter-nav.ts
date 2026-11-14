import type { useNavigate } from "@tanstack/react-router";

import { tokenizeQuery } from "../data/filter-query";
import { openNodeSwitcher } from "./node-switcher-opener";

// The `?q=` filter is CORE chrome now (the query grammar, ADR 0047 §6). This
// module holds the route writers so surfaces OUTSIDE the React tree (a
// tags-plugin chip click, the Cmd+F hotkey, Find's Show in outline) can drive
// the filter without a hook. The React half (the hook + the applied-filter
// pill) lives in `query-filter.tsx`, which binds these on mount.

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
  if (root === null)
    return navigateRef({ to: "/", search: nextSearch, replace });
  else
    return navigateRef({
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

/** Cmd+F, the More menu, and the filter pill all open the one search box,
 *  scoped to the current node and prefilled with the active filter. */
export function openFilterInput() {
  openNodeSwitcher({
    query: new URLSearchParams(window.location.search).get("q") ?? "",
    scope: "here",
  });
}
