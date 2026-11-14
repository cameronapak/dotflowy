import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { CloseIcon, FilterIcon, PinIcon, SearchIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";

import type { ViewContext } from "../plugins/types";

import { tokenizeQuery } from "../data/filter-query";
import { isMirrorsEnabled } from "../data/flags";
import { flattenInline } from "../data/inline-text";
import { toggleSavedQuery, useIsQuerySaved } from "../data/saved-queries";
import { trueSourceOf } from "../data/tree";
import { useTree } from "../data/useTree";
import { buildViewFilter, composeHidden } from "../plugins/registry";
import { openNodeSwitcher } from "./node-switcher-opener";
import {
  addTermToFilter,
  bindQueryFilterNav,
  openFilterInput,
  writeQuery,
} from "./query-filter-nav";
import { useShowCompleted } from "./show-completed-provider";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

// The `?q=` filter is CORE chrome (the query grammar, ADR 0047 §6). Find is the
// only search box; this file owns the applied-filter pill, the route hook, and
// the empty-filter recovery. The tags plugin only contributes a `#tag` term on
// chip click (Seam B, via {@link addTermToFilter}). Re-exported here so this
// file is the single filter surface.
export { addTermToFilter };

/** Mounted only for an empty filter: full-index recovery reads never subscribe
 * the nonempty editor to unrelated keystrokes. Counts are undimmed render paths
 * (including revealed descendants), exactly as the outline filter builds them. */
export function QueryFilterEmptyState({ viewCtx }: { viewCtx: ViewContext }) {
  const { index } = useTree();
  const { setShowCompleted } = useShowCompleted();
  const query = viewCtx.search.q ?? "";
  const recovery = useMemo(() => {
    const count = (ctx: ViewContext) =>
      buildViewFilter(index, ctx, composeHidden(ctx))?.matchIds.size ?? 0;
    const completed = viewCtx.showCompleted
      ? 0
      : count({ ...viewCtx, showCompleted: true });
    const tokens = tokenizeQuery(query);
    const removals =
      tokens.length <= 1
        ? []
        : tokens.flatMap((term, i) => {
            // Removing an OR operand changes the meaning of its neighbor. Offer only
            // independent AND terms; preserve quoted phrases via the shared tokenizer.
            if (
              term === "OR" ||
              tokens[i - 1] === "OR" ||
              tokens[i + 1] === "OR"
            )
              return [];
            const next = tokens.filter((_, j) => j !== i).join(" ");
            const matches = count({
              ...viewCtx,
              search: { ...viewCtx.search, q: next },
            });
            return matches > 0 ? [{ term, next, matches, position: i }] : [];
          });
    return {
      completed,
      removals: removals
        .sort((a, b) => b.matches - a.matches || a.position - b.position)
        .slice(0, 2),
    };
  }, [index, viewCtx, query]);
  const root =
    viewCtx.rootId === null ? undefined : index.byId.get(viewCtx.rootId);
  const titleNode =
    root && isMirrorsEnabled()
      ? index.byId.get(trueSourceOf(index, root.id))
      : root;
  const title = flattenInline(titleNode?.text ?? "").trim() || "Untitled";
  const hasRecovery = recovery.completed > 0 || recovery.removals.length > 0;

  return (
    <section
      className="outline-empty flex max-w-md flex-col gap-4"
      aria-label="No filter matches"
    >
      <div className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground">
          {viewCtx.rootId === null ? "No matches" : `No matches in ${title}`}
        </h2>
        <p className="break-words">
          Nothing here matches &quot;{query}&quot;. Find looks through your
          whole outline.
        </p>
      </div>
      <Button
        aria-label="Find everywhere"
        className="min-h-11 w-full md:w-fit"
        onClick={() => openNodeSwitcher({ query })}
      >
        <SearchIcon data-icon="inline-start" />
        Find everywhere
        <Kbd className="ml-2 max-md:hidden">⌘K</Kbd>
      </Button>
      <div className="flex flex-col gap-1">
        <p className="mb-1">
          {hasRecovery ? "Or change this filter" : "Or start over"}
        </p>
        {recovery.completed > 0 && (
          <Button
            variant="ghost"
            className="min-h-11 w-full justify-between gap-4"
            onClick={() => setShowCompleted(true)}
          >
            <span>Show completed</span>
            <span className="text-muted-foreground tabular-nums">
              {recovery.completed}
            </span>
          </Button>
        )}
        {recovery.removals.map(({ term, next, matches, position }) => (
          <Button
            key={position}
            variant="ghost"
            className="min-h-11 w-full justify-between gap-4"
            onClick={() => writeQuery(next)}
          >
            <span className="truncate">Remove &quot;{term}&quot;</span>
            <span className="text-muted-foreground tabular-nums">
              {matches}
            </span>
          </Button>
        ))}
        <Button
          variant="ghost"
          className="min-h-11 w-full justify-between gap-4"
          onClick={() => writeQuery("")}
        >
          <span>Clear filter</span>
          <span className="text-muted-foreground">Show everything</span>
        </Button>
      </div>
    </section>
  );
}

/** The `?q=` filter state + route writers. Reads route state directly (no bridge
 *  needed) and owns the window-level Escape clear. */
export function useQueryFilter() {
  const params = useParams({ strict: false });
  const rootId = params.nodeId ?? null;
  const navigate = useNavigate();
  // SAFETY: URL search params are string-valued, only the optional q string is read
  const search = useSearch({ strict: false }) as { q?: string };
  const rawQuery = search.q ?? "";
  const active = rawQuery.trim().length > 0;

  useEffect(() => {
    bindQueryFilterNav(navigate, rootId);
  }, [navigate, rootId]);

  const clear = useCallback(() => writeQuery(""), []);

  // Window-level Escape (ADR 0047 §6): with an active filter and no input
  // focused, Escape clears the whole filter in one press -- but NOT while a
  // bullet caret is in the outline. The input's own Escape (its ladder) stops
  // propagation, so this only fires when the caret is elsewhere.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A capture-phase handler already claimed this Escape (node multi-selection
      // exits, an open caret menu closes -- both preventDefault). Don't ALSO clear.
      if (e.defaultPrevented) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.classList.contains("node-text"))
        return;
      // A modal overlay (Cmd+K, a confirm dialog, a plugin sheet) owns Escape --
      // closing it must not clear the filter underneath it.
      if (document.querySelector('[role="dialog"], dialog[open]')) return;
      clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, clear]);

  return { rawQuery, active, clear };
}

/**
 * The applied filter, shown as a pill in the subheader (one search box design).
 * There is no resident filter input: Find is the only box. Find's Show in
 * outline writes `?q=`, and this pill keeps that query visible while you work
 * in the live, editable outline. Clicking the pill reopens Find scoped to the
 * current node with the query prefilled; the pin saves it (ADR 0048); the X
 * clears it. Cmd+F opens Find scoped here (virtualization already broke native
 * browser find, so taking it over is a repair, ADR 0047 §6).
 */
export function QueryFilterBar() {
  const { rawQuery, active, clear } = useQueryFilter();
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const isSaved = useIsQuerySaved(rawQuery);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        if (document.querySelector('[role="dialog"], dialog[open]')) return;
        e.preventDefault();
        openFilterInput();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!active) return null;

  const place = rootId === null ? "Home" : "this node";

  return (
    <search
      aria-label="Filter"
      className="flex max-w-full min-w-0 items-center gap-0.5 rounded-full bg-muted py-0.5 pr-1 pl-1 text-sm"
    >
      <button
        type="button"
        data-filter-pill=""
        onClick={() => openFilterInput()}
        aria-label={`Edit filter ${rawQuery} in ${place}`}
        className="flex min-h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2 hover:bg-background/60 max-sm:min-h-11"
      >
        <FilterIcon className="size-3.5 shrink-0" />
        <span className="truncate">{rawQuery}</span>
        <span className="shrink-0 text-muted-foreground">in {place}</span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => toggleSavedQuery(rawQuery)}
        aria-label={isSaved ? "Unsave filter" : "Save filter"}
        aria-pressed={isSaved}
        className={cn(
          "rounded-full max-sm:size-11",
          isSaved ? "text-primary" : "text-muted-foreground",
        )}
      >
        <PinIcon className={cn(isSaved && "fill-current")} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={clear}
        aria-label="Clear filter"
        className="rounded-full text-muted-foreground max-sm:size-11"
      >
        <CloseIcon />
      </Button>
    </search>
  );
}
