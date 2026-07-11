import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { tokenizeQuery } from "../data/filter-query";
import {
  addTermToFilter,
  bindQueryFilterNav,
  setFilterInputOpener,
  writeQuery,
  writeQueryTokens,
} from "./query-filter-nav";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// The `?q=` filter is CORE chrome now (the query grammar, ADR 0047 §6): a
// summoned input in the subheader, opened by Cmd+F, the Cmd+K "Filter this view"
// action, or tapping the active-filter pill bar. Composing shows the RAW query
// text (live-as-you-type, debounced `router.replace`); blurred-with-a-filter
// shows the parsed surface tokens as removable pills. The tags plugin no longer
// owns this -- it only contributes a `#tag` term on chip click (Seam B, via
// {@link addTermToFilter}). Re-exported here so this file is the single filter
// surface.
export { addTermToFilter };

const DEBOUNCE_MS = 200;

/** The `?q=` surface-token state + route writers, shared by the pill bar and the
 *  Cmd+K action. Reads route state directly (no bridge needed). */
export function useQueryFilter() {
  const params = useParams({ strict: false });
  const rootId = params.nodeId ?? null;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { q?: string };
  const rawQuery = search.q ?? "";
  const tokens = useMemo(() => tokenizeQuery(search.q), [search.q]);
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;

  useEffect(() => {
    bindQueryFilterNav(navigate, rootId);
  }, [navigate, rootId]);

  const removeToken = useCallback((token: string) => {
    // Drop only the FIRST occurrence, so duplicate literals stay addressable.
    const current = tokensRef.current;
    const i = current.indexOf(token);
    if (i === -1) return;
    writeQueryTokens([...current.slice(0, i), ...current.slice(i + 1)]);
  }, []);

  const clear = useCallback(() => writeQueryTokens([]), []);

  // Stage-2 Escape (ADR 0047 §6): with an active filter and no input focused,
  // Escape clears the whole filter -- but NOT while a bullet caret is in the
  // outline. The input's own Escape (stage 1) stops propagation, so on the first
  // press this never fires; the second press (input already closed) does.
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

  return { tokens, rawQuery, removeToken, clear };
}

/** A `#tag` surface token gets its painted chip (`data-tag` -> TagColorStyles);
 *  every other term (`is:todo`, `"a phrase"`, `-word`, `OR`) is a plain outline
 *  pill. */
function isTagToken(token: string): boolean {
  return /^#[\p{L}\p{N}_-]+$/u.test(token);
}

function FilterPill({
  token,
  onRemove,
}: {
  token: string;
  onRemove: (token: string) => void;
}) {
  const isTag = isTagToken(token);
  return (
    <Badge
      variant="outline"
      {...(isTag ? { "data-tag-pill": true, "data-tag": token.slice(1) } : {})}
      className="gap-0.5 pr-0.5"
    >
      {token}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-tag-pill-remove
        className="size-5 shrink-0 text-inherit opacity-60 hover:!bg-current/10 hover:!text-inherit hover:opacity-100 dark:hover:!bg-current/15"
        aria-label={`Remove ${token} from filter`}
        onClick={() => onRemove(token)}
      >
        <X />
      </Button>
    </Badge>
  );
}

function FilterPillBar({
  tokens,
  onRemove,
  onClear,
  onEdit,
}: {
  tokens: string[];
  onRemove: (token: string) => void;
  onClear: () => void;
  onEdit: () => void;
}) {
  return (
    <search
      aria-label="Filter"
      className="flex w-full flex-wrap items-center gap-1.5"
      // Tapping the bar (not a pill's X, not Clear) swaps it back into the input
      // for editing (ADR 0047 §6). `closest("button")` lets the X/Clear buttons
      // win the click.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onEdit();
      }}
    >
      {tokens.map((token, i) => (
        // Tokens can repeat (two `#a`s), so the key includes the index.
        <FilterPill key={`${token}:${i}`} token={token} onRemove={onRemove} />
      ))}
      <Button type="button" variant="ghost" size="xs" onClick={onClear}>
        Clear
      </Button>
    </search>
  );
}

/**
 * The core subheader filter surface: an input while composing, the parsed-term
 * pill bar while a filter is active, and NOTHING (so the subheader collapses)
 * when idle. Summoned via {@link openFilterInput} (Cmd+F / the Cmd+K action) or
 * by tapping the pill bar.
 */
export function QueryFilterBar() {
  const { tokens, rawQuery, removeToken, clear } = useQueryFilter();
  const [inputOpen, setInputOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  // Live raw query, read at open time without re-binding the mount-once opener.
  const rawRef = useRef(rawQuery);
  rawRef.current = rawQuery;

  const flush = useCallback((value: string) => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    writeQuery(value, { replace: true });
  }, []);

  const open = useCallback(() => {
    // Prefill with the raw `?q=` string (caret goes to the end in the focus
    // effect), so summoning an active filter lands you editing it.
    setDraft(rawRef.current);
    setInputOpen(true);
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

  // Focus + caret-to-end once the input mounts. Deferred a frame so it wins the
  // focus race against Radix restoring focus when the Cmd+K dialog closes.
  useEffect(() => {
    if (!inputOpen) return;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(id);
  }, [inputOpen]);

  if (inputOpen) {
    const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setDraft(value);
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        writeQuery(value, { replace: true });
      }, DEBOUNCE_MS);
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        // Commit immediately and show pills.
        e.preventDefault();
        flush(draft);
        setInputOpen(false);
      } else if (e.key === "Escape") {
        // Stage 1: flush, close the input (pills remain if a filter is active).
        // Stop propagation so the window-level stage-2 clear doesn't also fire.
        e.preventDefault();
        e.stopPropagation();
        flush(draft);
        setInputOpen(false);
      }
    };
    const onBlur = () => {
      flush(draft);
      setInputOpen(false);
    };
    return (
      <search aria-label="Filter" className="w-full">
        <Input
          ref={inputRef}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder="Filter… e.g. #work is:todo -done"
          aria-label="Filter query"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </search>
    );
  }

  if (tokens.length === 0) return null;

  return (
    <FilterPillBar
      tokens={tokens}
      onRemove={removeToken}
      onClear={clear}
      onEdit={open}
    />
  );
}
