import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Pencil, Pin, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

import {
  buildFilterSuggestions,
  caretToken,
  type FilterSuggestion,
} from "../data/filter-query";
import {
  deleteSavedQuery,
  renameSavedQuery,
  toggleSavedQuery,
  useIsQuerySaved,
  useSavedQueries,
} from "../data/saved-queries";
import { normalizeQuery } from "../data/saved-queries-core";
import { collectTagCorpus } from "../data/tags";
import { getTreeIndex } from "../data/tree-store";
import { filterOperatorInfos } from "../plugins/registry";
import {
  addTermToFilter,
  bindQueryFilterNav,
  setFilterInputController,
  toggleFilterInput,
  writeQuery,
} from "./query-filter-nav";
import { SUBHEADER_EXPAND_MS } from "./subheader-expand";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// The `?q=` filter is CORE chrome now (the query grammar, ADR 0047 §6): a
// resident input in the subheader, opened by Cmd+F, the Cmd+K "Filter this view"
// action, or the header magnifier. It shows the RAW query text (live-as-you-type,
// debounced `router.replace`) and STAYS resident -- focused or not -- as long as
// `?q=` is non-empty (the blurred-with-pills state is dead, amended ADR 0047 §6).
// The tags plugin no longer owns this -- it only contributes a `#tag` term on
// chip click (Seam B, via {@link addTermToFilter}). Re-exported here so this file
// is the single filter surface.
export { addTermToFilter };

const DEBOUNCE_MS = 200;

/** The `?q=` filter state + route writers. Reads route state directly (no bridge
 *  needed) and owns the window-level Escape clear. */
export function useQueryFilter() {
  const params = useParams({ strict: false });
  const rootId = params.nodeId ?? null;
  const navigate = useNavigate();
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
      if (document.querySelector('[role="dialog"]')) return;
      clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, clear]);

  return { rawQuery, active, clear };
}

/** The header magnifier -- toggles the filter input (ADR 0047 §6: the magnifier
 *  filters the view; the switcher moved to its own ⌘ button). Open when idle;
 *  a second press dismisses (clears + collapses). `preventDefault` on
 *  pointerdown keeps the input focused across the press so blur doesn't
 *  collapse-then-reopen before the click can close.
 *
 *  Lit (solid `--primary`, ADR 0033's grayscale "on" idiom -- same as
 *  SpotlightIndicator) whenever a `?q=` filter is applied, so the magnifier
 *  reads as a pressed toggle. This is intentional: the toggle-off press that
 *  WIPES the query only fires while the button visibly signals "on". Reads the
 *  search param directly rather than `useQueryFilter()`, whose Escape/nav side
 *  effects would double-bind if this button ran them too. */
export function FilterButton() {
  const search = useSearch({ strict: false }) as { q?: string };
  const active = (search.q ?? "").trim().length > 0;
  return (
    <Button
      variant={active ? "default" : "ghost"}
      size="icon-sm"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleFilterInput()}
      aria-label="Filter this view"
      aria-pressed={active}
    >
      <Search />
      <span className="sr-only">Filter this view</span>
    </Button>
  );
}

const LISTBOX_ID = "filter-suggestions";
const optionId = (i: number) => `filter-suggestion-${i}`;

/** One autocomplete row: a colored `#tag` chip, an operator value (with a color
 *  swatch for `highlight:`), or a cheat-sheet key + description. */
function SuggestionRow({
  suggestion,
  id,
  active,
  onPick,
}: {
  suggestion: FilterSuggestion;
  id: string;
  active: boolean;
  onPick: (s: FilterSuggestion) => void;
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        active && "bg-accent text-accent-foreground",
      )}
      // Keep the input focused across the press (the row lives in a portal, so a
      // plain click would blur -> close the popover before onClick fires).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(suggestion)}
    >
      {suggestion.display === "tag" ? (
        <Badge
          variant="outline"
          className="text-[0.85em]"
          data-tag={suggestion.tag}
        >
          {suggestion.label}
        </Badge>
      ) : suggestion.swatch ? (
        <>
          {/* Soft-bordered fill -- the highlight/tag color-menu swatch. */}
          <span
            aria-hidden="true"
            className="size-3.5 shrink-0 rounded-full border"
            style={{ background: `var(--tag-${suggestion.swatch})` }}
          />
          <span className="font-mono text-xs">{suggestion.label}</span>
        </>
      ) : (
        <>
          <span className="font-mono text-xs">{suggestion.label}</span>
          {suggestion.description ? (
            <span className="truncate text-xs text-muted-foreground">
              {suggestion.description}
            </span>
          ) : null}
        </>
      )}
    </li>
  );
}

const SAVED_SECTION_CAP = 6;

/** The "Saved" section atop the filter popover's cheat sheet (ADR 0048): the
 *  user summoned search, so their saved searches lead. Newest-first, top ~6.
 *  Clicking a row fills the input AND applies the query; hover reveals a pencil
 *  (inline rename) and an X (delete). Rename/delete live ONLY here -- Cmd+K just
 *  lists and runs.
 *
 *  Keyboard nav (Arrow/Enter) stays owned by the suggestion listbox below; these
 *  saved rows are MOUSE-ONLY for v1 (ADR 0048 leaves that open) so they don't
 *  entangle the existing autocomplete `activeIndex` walk. */
function SavedQueriesSection({
  anchorRef,
  onPick,
}: {
  anchorRef: React.RefObject<HTMLInputElement | null>;
  onPick: (query: string) => void;
}) {
  const saved = useSavedQueries();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const top = saved.slice(0, SAVED_SECTION_CAP);

  useLayoutEffect(() => {
    if (renamingId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingId]);

  // Section renders nothing when there are no saved queries (ADR 0048).
  if (top.length === 0) return null;

  const startRename = (id: string, name: string) => {
    setNameDraft(name);
    setRenamingId(id);
  };
  // Return focus to the filter input so its focused-state stays real after the
  // rename input unmounts (the main input's onBlur was guarded, not fired).
  const endRename = () => {
    setRenamingId(null);
    anchorRef.current?.focus();
  };
  const commitRename = () => {
    if (renamingId) renameSavedQuery(renamingId, nameDraft);
    endRename();
  };

  return (
    <div className="border-b p-1" aria-label="Saved filters">
      <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
        Saved
      </div>
      {top.map((row) =>
        renamingId === row.id ? (
          <div key={row.id} className="px-2 py-1">
            <input
              ref={renameRef}
              value={nameDraft}
              // Let the rename input take focus (the container preventDefaults
              // mousedown to keep the filter input focused; stop it here).
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                // Own Enter/Escape locally; never bubble to the filter input's
                // ladder or the window Escape clear.
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  endRename();
                }
              }}
              // Blur = cancel (Enter is the only commit path, ADR 0048).
              onBlur={endRename}
              className="w-full rounded border bg-background px-1.5 py-0.5 text-sm"
              aria-label="Rename saved filter"
              spellCheck={false}
            />
          </div>
        ) : (
          <div
            key={row.id}
            className="group/saved flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
              onClick={() => onPick(row.query)}
            >
              <span className="truncate">{row.name}</span>
              {normalizeQuery(row.name) !== normalizeQuery(row.query) ? (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {row.query}
                </span>
              ) : null}
            </button>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/saved:opacity-100">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Rename ${row.name}`}
                onClick={() => startRename(row.id, row.name)}
                className="text-muted-foreground"
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${row.name}`}
                onClick={() => deleteSavedQuery(row.id)}
                className="text-muted-foreground"
              >
                <X />
              </Button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/** The suggestion listbox, portaled to the body (the subheader's height-animated
 *  wrapper is `overflow-hidden`, which would clip an in-flow dropdown) and
 *  fixed-positioned under the input. Its `role="listbox"` also keeps a mousedown
 *  inside it from clearing an active node selection (selection-mode.tsx). The
 *  optional Saved section (ADR 0048) leads on empty focus. Enter animation is
 *  `[data-filter-popover]` in styles.css (220ms fade + slide). */
function SuggestionPopover({
  anchorRef,
  suggestions,
  activeIndex,
  onPick,
  showSaved,
  onPickSaved,
}: {
  anchorRef: React.RefObject<HTMLInputElement | null>;
  suggestions: FilterSuggestion[];
  activeIndex: number;
  onPick: (s: FilterSuggestion) => void;
  showSaved: boolean;
  onPickSaved: (query: string) => void;
}) {
  // Eager measure so the first paint already has a rect (avoids a null→mount
  // flash that would skip or clip the CSS enter animation).
  const [rect, setRect] = useState<DOMRect | null>(
    () => anchorRef.current?.getBoundingClientRect() ?? null,
  );
  useLayoutEffect(() => {
    const measure = () => {
      const el = anchorRef.current;
      if (el) setRect(el.getBoundingClientRect());
    };
    measure();
    window.addEventListener("resize", measure);
    // Capture-phase: the sticky header sits in a scroll container.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef]);

  if (!rect) return null;
  return createPortal(
    <div
      data-filter-popover
      className="fixed z-50 max-h-80 origin-top overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-md"
      style={{ left: rect.left, top: rect.bottom + 4, width: rect.width }}
      // A press anywhere in the popover must not blur the input (the rename input
      // stops its own mousedown so it can still take focus).
      onMouseDown={(e) => e.preventDefault()}
    >
      {showSaved ? (
        <SavedQueriesSection anchorRef={anchorRef} onPick={onPickSaved} />
      ) : null}
      <ul
        id={LISTBOX_ID}
        role="listbox"
        aria-label="Filter suggestions"
        data-filter-suggestions
        className="p-1"
      >
        {suggestions.map((s, i) => (
          <SuggestionRow
            key={s.id}
            suggestion={s}
            id={optionId(i)}
            active={i === activeIndex}
            onPick={onPick}
          />
        ))}
      </ul>
    </div>,
    document.body,
  );
}

/**
 * The core subheader filter surface: a resident input whenever a filter is
 * active OR the input was summoned, and NOTHING (so the subheader collapses)
 * when idle with no query. Summoned via {@link toggleFilterInput} / Cmd+F /
 * the Cmd+K action; the header magnifier toggles (open ↔ dismiss). The
 * blurred-with-pills state is gone
 * (ADR 0047 §6, amended): while `?q=` is non-empty the raw query stays in the
 * input, focused or not.
 */
export function QueryFilterBar() {
  const { rawQuery, active } = useQueryFilter();
  // `summoned` keeps the input open when there's no query yet (an empty summon);
  // an active filter keeps it resident on its own. Blur with empty text drops
  // `summoned`, which -- with no query -- collapses the row.
  const [summoned, setSummoned] = useState(false);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  // Live draft for blur/close — a setState + blur in the same tick would otherwise
  // flush the pre-clear value from the onBlur closure and resurrect `?q=`.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Autocomplete (ADR 0047 §7): suggestions for the token at the caret, the
  // active row, and whether the popover is showing (Escape stage 0 hides it).
  const [suggestions, setSuggestions] = useState<FilterSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Live raw query, read at open time without re-binding the mount-once opener.
  const rawRef = useRef(rawQuery);
  rawRef.current = rawQuery;
  // While the subheader expands on a fresh summon, onFocus must not open the
  // popover early — timestamp until which reveal is deferred.
  const deferPopoverUntilRef = useRef(0);

  // Pin pressed-state (ADR 0048): filled when the current (trimmed) query is
  // already saved. Reads `draft` so it tracks the input even while composing.
  const isSaved = useIsQuerySaved(draft);

  const showInput = summoned || active;

  // While NOT focused, mirror the input to `?q=` -- so an external write (a tag
  // chip click AND-ing `#tag`, a shared `?q=` URL) shows up in the resident
  // input. While focused the draft is user-owned; the debounced write drives the
  // URL, so clobbering it here would fight the caret.
  useEffect(() => {
    if (!focused) setDraft(rawQuery);
  }, [rawQuery, focused]);

  const flush = useCallback((value: string) => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    writeQuery(value, { replace: true });
  }, []);

  const scheduleWrite = useCallback((value: string) => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      writeQuery(value, { replace: true });
    }, DEBOUNCE_MS);
  }, []);

  // A queued write must die with the component -- firing after unmount would
  // stamp a stale `?q=` onto whatever route replaced the editor.
  useEffect(
    () => () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    },
    [],
  );

  // Recompute the suggestions from the LIVE input (value + caret), so the token
  // is always exactly what the browser sees. Cheap; runs only while composing.
  const recompute = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const { token } = caretToken(el.value, caret);
    const tags = collectTagCorpus(getTreeIndex().tagCorpus);
    setSuggestions(buildFilterSuggestions(token, filterOperatorInfos, tags));
    setActiveIndex(-1);
  }, []);

  // Insert a suggestion: replace the caret token with its text (a leading `-`,
  // if any, was already folded into `insert`), keep the input open, then apply
  // the caret + recompute after React commits so a bare `key:` chains straight
  // into value suggestions. Writes flow through the same debounced `?q=` path.
  const applySuggestion = useCallback(
    (s: FilterSuggestion) => {
      const el = inputRef.current;
      if (!el) return;
      const value = el.value;
      const caret = el.selectionStart ?? value.length;
      const tok = caretToken(value, caret);
      const nextValue =
        value.slice(0, tok.start) + s.insert + value.slice(tok.end);
      const nextCaret = tok.start + s.insert.length;
      setDraft(nextValue);
      scheduleWrite(nextValue);
      setPopoverOpen(true);
      requestAnimationFrame(() => {
        const el2 = inputRef.current;
        if (!el2) return;
        el2.focus();
        el2.setSelectionRange(nextCaret, nextCaret);
        recompute();
      });
    },
    [scheduleWrite, recompute],
  );

  // Pick a saved query (ADR 0048): fill the input AND apply it. Keeps the input
  // focused with the caret at the end so it flows into editing.
  const pickSaved = useCallback(
    (query: string) => {
      setDraft(query);
      flush(query);
      setPopoverOpen(true);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(query.length, query.length);
        recompute();
      });
    },
    [flush, recompute],
  );

  const open = useCallback(() => {
    // Prefill with the raw `?q=` string (caret goes to the end in the focus
    // effect), so summoning an active filter lands you editing it.
    setDraft(rawRef.current);
    setSummoned(true);
  }, []);

  // Dismiss: wipe any pending/active query and collapse the row. Used by the
  // header magnifier's toggle-off path (open-only stays on Cmd+F / Cmd+K).
  const close = useCallback(() => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    draftRef.current = "";
    setDraft("");
    writeQuery("", { replace: true });
    setSummoned(false);
    setPopoverOpen(false);
    setFocused(false);
    inputRef.current?.blur();
  }, []);

  // Live open-probe for the header toggle -- `showInput` itself isn't stable
  // across the mount-once registration, so the probe reads refs/state live.
  const summonedRef = useRef(summoned);
  summonedRef.current = summoned;
  const isOpen = useCallback(
    () => summonedRef.current || rawRef.current.trim().length > 0,
    [],
  );

  // Register the summon/dismiss controller (Cmd+K / chip taps / magnifier).
  useEffect(() => {
    setFilterInputController({ open, close, isOpen });
    return () => setFilterInputController(null);
  }, [open, close, isOpen]);

  // Cmd+F summons the input (ADR 0047 §6): virtualization already broke native
  // browser find, so hijacking it is a repair. Capture phase + preventDefault,
  // works whether or not a bullet is focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [open]);

  // Focus + caret-to-end when the input is SUMMONED (not merely resident from a
  // URL query -- a page load with `?q=` must not steal the caret). Deferred a
  // frame so it wins the focus race against Radix restoring focus when the
  // Cmd+K dialog closes. The suggestion popover waits for the subheader expand
  // animation when the band was collapsed -- opening it mid-slide pins it to a
  // stale input rect (portaled, fixed).
  useEffect(() => {
    if (!summoned) return;
    // Collapsed → expand animates; already-resident (active `?q=`) does not.
    const needsExpandWait = rawRef.current.trim().length === 0;
    let popoverTimer: number | null = null;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      recompute();
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (needsExpandWait && !reduceMotion) {
        // onFocus would open immediately; hold until the band settles.
        deferPopoverUntilRef.current = Date.now() + SUBHEADER_EXPAND_MS;
        setPopoverOpen(false);
        popoverTimer = window.setTimeout(() => {
          popoverTimer = null;
          deferPopoverUntilRef.current = 0;
          if (document.activeElement === inputRef.current) {
            setPopoverOpen(true);
            recompute();
          }
        }, SUBHEADER_EXPAND_MS);
      } else {
        setPopoverOpen(true);
      }
    });
    return () => {
      cancelAnimationFrame(id);
      if (popoverTimer != null) window.clearTimeout(popoverTimer);
      deferPopoverUntilRef.current = 0;
    };
  }, [summoned, recompute]);

  if (!showInput) return null;

  const showPopover = focused && popoverOpen && suggestions.length > 0;
  // Trailing controls (pin + clear) show together whenever the input has text.
  const showControls = draft.length > 0;
  // The Saved section (ADR 0048) leads the cheat sheet on empty focus.
  const showSaved = draft.trim().length === 0;

  // Blur to the outline: flush the pending write and drop the summon flag. With
  // no query left the row collapses; with an active query the input stays
  // resident (blurred), showing the raw string.
  const collapse = () => {
    flush(draftRef.current);
    setSummoned(false);
    setPopoverOpen(false);
    inputRef.current?.blur();
  };

  // The clear X (and Escape stage 2): wipe the text AND `?q=`, keeping focus.
  const clearText = (reopenCheatSheet: boolean) => {
    draftRef.current = "";
    setDraft("");
    flush("");
    setActiveIndex(-1);
    setPopoverOpen(reopenCheatSheet);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, 0);
      if (reopenCheatSheet) recompute();
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    draftRef.current = value;
    setDraft(value);
    scheduleWrite(value);
    setPopoverOpen(true);
    recompute();
  };

  const onFocus = () => {
    setFocused(true);
    recompute();
    // Fresh summon: the summon effect opens the popover after the expand anim.
    if (Date.now() < deferPopoverUntilRef.current) return;
    setPopoverOpen(true);
  };

  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    // Focus moving INTO the popover (the Saved rename input) must not collapse
    // it -- return before any state change so `focused` stays true and the
    // popover (hence the rename input) stays mounted (ADR 0048).
    const rt = e.relatedTarget as HTMLElement | null;
    if (rt && rt.closest("[data-filter-popover]")) return;
    setFocused(false);
    // Flush without dropping residency: a blurred active filter stays in the
    // input. An empty draft collapses via `showInput` once the write lands.
    // Read the live draft (not the render closure) so a close()+blur in the
    // same tick can't resurrect a just-cleared query.
    flush(draftRef.current);
    setSummoned(false);
    setPopoverOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (!showPopover) return;
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === "ArrowUp") {
      if (!showPopover) return;
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      return;
    }
    if (e.key === "Tab") {
      // Tab accepts the active row (or the first, autocomplete-style); with no
      // popover it keeps native focus movement.
      if (!showPopover) return;
      e.preventDefault();
      applySuggestion(suggestions[activeIndex >= 0 ? activeIndex : 0]!);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // With a highlighted row, Enter inserts it (stays open). Otherwise it
      // commits: flush the debounce and blur to the outline.
      if (showPopover && activeIndex >= 0) {
        applySuggestion(suggestions[activeIndex]!);
        return;
      }
      collapse();
      return;
    }
    if (e.key === "Escape") {
      // Stop propagation so the window-level clear never also fires.
      e.preventDefault();
      e.stopPropagation();
      // Ladder (ADR 0047 §6): (1) an open popover closes first; (2) else text is
      // cleared, focus kept; (3) else the row collapses.
      if (showPopover) {
        setPopoverOpen(false);
        return;
      }
      if (draft.length > 0) {
        clearText(false);
        return;
      }
      collapse();
      return;
    }
  };

  return (
    <search aria-label="Filter" className="relative w-full">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        value={draft}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder="Filter… e.g. #work is:todo -done"
        aria-label="Filter query"
        role="combobox"
        aria-expanded={showPopover}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={
          showPopover && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className={cn("pl-8", showControls && "pr-14")}
      />
      {showControls ? (
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
          {/* Pin toggle (ADR 0048): instant save/unsave of the current query,
              no naming prompt. Pressed/filled when already saved. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            // Keep focus across the press (like the clear X) so saving doesn't
            // blur -> collapse the input.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleSavedQuery(draft)}
            aria-label={isSaved ? "Unsave filter" : "Save filter"}
            aria-pressed={isSaved}
            className={cn(isSaved ? "text-primary" : "text-muted-foreground")}
          >
            <Pin className={cn(isSaved && "fill-current")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            // Keep focus across the press so clearing doesn't blur -> collapse.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => clearText(true)}
            aria-label="Clear filter"
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>
      ) : null}
      {showPopover ? (
        <SuggestionPopover
          anchorRef={inputRef}
          suggestions={suggestions}
          activeIndex={activeIndex}
          onPick={applySuggestion}
          showSaved={showSaved}
          onPickSaved={pickSaved}
        />
      ) : null}
    </search>
  );
}
