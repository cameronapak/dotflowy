import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
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
import { collectTagCorpus } from "../data/tags";
import { getTreeIndex } from "../data/tree-store";
import { filterOperatorInfos } from "../plugins/registry";
import {
  addTermToFilter,
  bindQueryFilterNav,
  openFilterInput,
  setFilterInputOpener,
  writeQuery,
} from "./query-filter-nav";
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

/** The header magnifier -- summons the filter input (ADR 0047 §6: the magnifier
 *  filters the view; the switcher moved to its own ⌘ button). */
export function FilterButton() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => openFilterInput()}
      aria-label="Filter this view"
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

/** The suggestion listbox, portaled to the body (the subheader's height-animated
 *  wrapper is `overflow-hidden`, which would clip an in-flow dropdown) and
 *  fixed-positioned under the input. Its `role="listbox"` also keeps a mousedown
 *  inside it from clearing an active node selection (selection-mode.tsx). */
function SuggestionPopover({
  anchorRef,
  suggestions,
  activeIndex,
  onPick,
}: {
  anchorRef: React.RefObject<HTMLInputElement | null>;
  suggestions: FilterSuggestion[];
  activeIndex: number;
  onPick: (s: FilterSuggestion) => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
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
    <ul
      id={LISTBOX_ID}
      role="listbox"
      aria-label="Filter suggestions"
      data-filter-suggestions
      className="fixed z-50 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: rect.left, top: rect.bottom + 4, width: rect.width }}
      // A press anywhere in the list must not blur the input.
      onMouseDown={(e) => e.preventDefault()}
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
    </ul>,
    document.body,
  );
}

/**
 * The core subheader filter surface: a resident input whenever a filter is
 * active OR the input was summoned, and NOTHING (so the subheader collapses)
 * when idle with no query. Summoned via {@link openFilterInput} (Cmd+F, the
 * Cmd+K action, the header magnifier). The blurred-with-pills state is gone
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
  // Autocomplete (ADR 0047 §7): suggestions for the token at the caret, the
  // active row, and whether the popover is showing (Escape stage 0 hides it).
  const [suggestions, setSuggestions] = useState<FilterSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Live raw query, read at open time without re-binding the mount-once opener.
  const rawRef = useRef(rawQuery);
  rawRef.current = rawQuery;

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

  const open = useCallback(() => {
    // Prefill with the raw `?q=` string (caret goes to the end in the focus
    // effect), so summoning an active filter lands you editing it.
    setDraft(rawRef.current);
    setSummoned(true);
  }, []);

  // Register the summon-opener (Cmd+K action / chip taps reach it) mount-once.
  useEffect(() => {
    setFilterInputOpener(open);
    return () => setFilterInputOpener(null);
  }, [open]);

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
  // Cmd+K dialog closes.
  useEffect(() => {
    if (!summoned) return;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      setPopoverOpen(true);
      recompute();
    });
    return () => cancelAnimationFrame(id);
  }, [summoned, recompute]);

  if (!showInput) return null;

  const showPopover = focused && popoverOpen && suggestions.length > 0;
  const showClear = draft.length > 0;

  // Blur to the outline: flush the pending write and drop the summon flag. With
  // no query left the row collapses; with an active query the input stays
  // resident (blurred), showing the raw string.
  const collapse = () => {
    flush(draft);
    setSummoned(false);
    setPopoverOpen(false);
    inputRef.current?.blur();
  };

  // The clear X (and Escape stage 2): wipe the text AND `?q=`, keeping focus.
  const clearText = (reopenCheatSheet: boolean) => {
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
    setDraft(value);
    scheduleWrite(value);
    setPopoverOpen(true);
    recompute();
  };

  const onFocus = () => {
    setFocused(true);
    setPopoverOpen(true);
    recompute();
  };

  const onBlur = () => {
    setFocused(false);
    // Flush without dropping residency: a blurred active filter stays in the
    // input. An empty draft collapses via `showInput` once the write lands.
    flush(draft);
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
        className={cn("pl-8", showClear && "pr-8")}
      />
      {showClear ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          // Keep focus across the press so clearing doesn't blur -> collapse.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => clearText(true)}
          aria-label="Clear filter"
          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
        >
          <X />
        </Button>
      ) : null}
      {showPopover ? (
        <SuggestionPopover
          anchorRef={inputRef}
          suggestions={suggestions}
          activeIndex={activeIndex}
          onPick={applySuggestion}
        />
      ) : null}
    </search>
  );
}
