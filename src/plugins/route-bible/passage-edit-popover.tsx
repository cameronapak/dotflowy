import {
  getMaxChapter,
  getMaxVerse,
  tryParsePassage,
  type OsisBookCode,
} from "grab-bcv";
import { ExternalLink } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { NodeCommands } from "../../components/OutlineNode";
import { placeCaretAtEnd } from "../../components/caret-place";
import { Button, Input } from "../kit";
import { replaceTokenInNode } from "../token-kit";
import type { PluginContext } from "../types";
import {
  coercePassageDraft,
  formatStructuredBibleRef,
  normalizeBibleRef,
  suggestBibleRefs,
} from "./bible";
import { fetchBsbChapter, type BsbVerse } from "./bsb";

type StructuredPassage = {
  book: OsisBookCode;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function structuredFromInput(input: string): StructuredPassage | null {
  // Strict first, then coerce trailing ":" so "Luke 8:" is chapter Luke 8
  // and the BSB reader (not verse-number autocomplete) stays up.
  for (const candidate of [input, coercePassageDraft(input)]) {
    if (!candidate.trim()) continue;
    const parsed = tryParsePassage(candidate);
    if (!parsed.ok) continue;
    const { start, end } = parsed.value;
    return {
      book: start.book,
      chapter: start.chapter,
      startVerse: start.verse ?? null,
      endVerse:
        start.verse != null &&
        end.book === start.book &&
        end.chapter === start.chapter
          ? (end.verse ?? start.verse)
          : null,
    };
  }
  return null;
}

function isInRange(
  n: number,
  start: number | null,
  end: number | null,
): boolean {
  if (start == null) return false;
  const hi = end ?? start;
  const lo = Math.min(start, hi);
  const top = Math.max(start, hi);
  return n >= lo && n <= top;
}

export function submitBiblePassageEdit(
  nodeId: string,
  oldToken: string,
  input: string,
  mutations: NodeCommands,
  sourceOffset = 0,
): void {
  const normalized = normalizeBibleRef(input);
  if (!normalized) return;
  const newToken = normalized.label;
  replaceTokenInNode(nodeId, oldToken, newToken, mutations, sourceOffset);
}

export function openBiblePassageEditPopover(
  args: {
    nodeId: string;
    token: string;
    focusTarget: HTMLElement | null;
    x: number;
    y: number;
    // Source offset of the clicked chip within its node — targets the right
    // occurrence when a line holds two identical refs (same book+chapter).
    sourceOffset?: number;
  },
  ctx: PluginContext,
): void {
  ctx.openOverlay(
    <BiblePassageEditPopover
      token={args.token}
      x={args.x}
      y={args.y}
      focusTarget={args.focusTarget}
      onSubmit={(input) =>
        submitBiblePassageEdit(
          args.nodeId,
          args.token,
          input,
          ctx.mutations,
          args.sourceOffset ?? 0,
        )
      }
      onClose={() => ctx.openOverlay(null)}
    />,
  );
}

export function BiblePassageEditPopover({
  token,
  x,
  y,
  focusTarget,
  onSubmit,
  onClose,
}: {
  token: string;
  x: number;
  y: number;
  focusTarget: HTMLElement | null;
  onSubmit: (input: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLFormElement | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const suggestionsId = useId();
  const initialStructured = structuredFromInput(token);
  const [draft, setDraft] = useState(token);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [structured, setStructured] = useState<StructuredPassage>(
    initialStructured ?? {
      book: "JHN",
      chapter: 3,
      startVerse: 16,
      endVerse: 16,
    },
  );
  const [verses, setVerses] = useState<BsbVerse[] | null>(null);
  const [bsbStatus, setBsbStatus] = useState<
    "idle" | "loading" | "ready" | "empty"
  >("idle");
  // Drag-to-select: anchor verse on pointerdown, extend through pointermove.
  // Kept in a ref so window listeners don't rebind every render; `dragging`
  // state only toggles CSS (`select-none` + cursor) on the reader shell.
  const dragAnchorRef = useRef<number | null>(null);
  /** Last pointer position while dragging — drives edge auto-scroll. */
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);
  const structuredRef = useRef(structured);
  structuredRef.current = structured;
  const [dragging, setDragging] = useState(false);

  const normalized = useMemo(() => normalizeBibleRef(draft), [draft]);
  // Structure suggestions only until a book+chapter resolves — then the
  // mini-reader is the selector (not a flat list of verse numbers).
  const parsedDraft = useMemo(() => structuredFromInput(draft), [draft]);
  const chapterReady = parsedDraft != null;
  const suggestions = useMemo(
    () => (chapterReady ? [] : suggestBibleRefs(draft)),
    [draft, chapterReady],
  );
  const activeSuggestionId =
    activeSuggestion >= 0 ? `${suggestionsId}-${activeSuggestion}` : undefined;

  useEffect(() => {
    setActiveSuggestion(suggestions.length > 0 ? 0 : -1);
  }, [suggestions]);

  useEffect(() => {
    const next = structuredFromInput(draft);
    if (next) setStructured(next);
  }, [draft]);

  const chapterBook = parsedDraft?.book ?? null;
  const chapterNum = parsedDraft?.chapter ?? null;

  // Load BSB for the current book+chapter whenever the chapter identity changes.
  useEffect(() => {
    if (chapterBook == null || chapterNum == null) {
      setVerses(null);
      setBsbStatus("idle");
      return;
    }
    let cancelled = false;
    setBsbStatus("loading");
    setVerses(null);
    void fetchBsbChapter(chapterBook, chapterNum).then((ch) => {
      if (cancelled) return;
      if (!ch) {
        setVerses(null);
        setBsbStatus("empty");
        return;
      }
      setVerses(ch.verses);
      setBsbStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [chapterBook, chapterNum]);

  // On open / chapter load / typed start verse: center the first selected
  // verse in the reader. Skip while drag-selecting (edge auto-scroll owns
  // scroll then), and ignore endVerse so extending a range doesn't re-center.
  useLayoutEffect(() => {
    if (dragging) return;
    if (!verses || !readerRef.current) return;
    const start = structured.startVerse;
    if (start == null) return;
    const el = readerRef.current.querySelector<HTMLElement>(
      `[data-verse="${start}"]`,
    );
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [verses, structured.startVerse, dragging]);

  const closeAndRefocus = useCallback(() => {
    onClose();
    requestAnimationFrame(() => {
      if (!focusTarget?.isConnected) return;
      focusTarget.focus({ preventScroll: true });
      placeCaretAtEnd(focusTarget);
    });
  }, [focusTarget, onClose]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeAndRefocus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAndRefocus();
    };
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [closeAndRefocus]);

  const applyStructured = useCallback((next: StructuredPassage) => {
    const safeChapter = clamp(next.chapter, 1, getMaxChapter(next.book));
    const verseCap = getMaxVerse(next.book, safeChapter) ?? 0;
    let safeStart =
      next.startVerse == null || verseCap === 0
        ? null
        : clamp(next.startVerse, 1, verseCap);
    let safeEnd =
      safeStart == null || next.endVerse == null
        ? safeStart
        : clamp(next.endVerse, 1, verseCap);
    // Always store lo..hi so formatStructuredBibleRef can emit a range.
    if (safeStart != null && safeEnd != null && safeEnd < safeStart) {
      const tmp = safeStart;
      safeStart = safeEnd;
      safeEnd = tmp;
    }
    const safe = {
      book: next.book,
      chapter: safeChapter,
      startVerse: safeStart,
      endVerse: safeEnd,
    };
    setStructured(safe);
    setDraft(formatStructuredBibleRef(safe));
  }, []);

  const openCurrent = () => {
    if (!normalized) return;
    window.open(normalized.url, "_blank", "noopener,noreferrer");
  };

  const applySuggestion = (index: number) => {
    const suggestion = suggestions[index];
    if (suggestion) setDraft(suggestion.insertText);
  };

  /** Apply a range from anchor..n (order-normalized inside applyStructured). */
  const selectRangeFrom = useCallback(
    (anchor: number, n: number) => {
      const cur = structuredRef.current;
      const lo = Math.min(anchor, n);
      const hi = Math.max(anchor, n);
      // Skip no-op updates — auto-scroll hits this every frame.
      if (cur.startVerse === lo && cur.endVerse === hi) return;
      applyStructured({
        ...cur,
        startVerse: lo,
        endVerse: hi,
      });
    },
    [applyStructured],
  );

  /**
   * Resolve which verse the pointer is over. Falls back to the nearest row by
   * Y when the pointer sits in reader padding / the auto-scroll edge (so slow
   * edge-scrolling still extends the range without a direct hit).
   */
  const verseAtPoint = useCallback((clientX: number, clientY: number): number | null => {
    const reader = readerRef.current;
    if (!reader) return null;
    const rect = reader.getBoundingClientRect();
    // Prefer a direct hit, but only trust it if it's inside our reader
    // (overlay chrome / other popovers can steal elementFromPoint).
    const hit = document.elementFromPoint(clientX, clientY);
    const direct = hit?.closest?.("[data-verse]") as HTMLElement | null;
    if (direct && reader.contains(direct)) {
      const n = Number(direct.getAttribute("data-verse"));
      return Number.isFinite(n) ? n : null;
    }

    const rows = reader.querySelectorAll<HTMLElement>("[data-verse]");
    if (rows.length === 0) return null;

    // Edge / outside the viewport: first or last *visible* row.
    if (clientY <= rect.top + 2) {
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (r.bottom > rect.top && r.top < rect.bottom) {
          const n = Number(row.getAttribute("data-verse"));
          return Number.isFinite(n) ? n : null;
        }
      }
    }
    if (clientY >= rect.bottom - 2) {
      let last: number | null = null;
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (r.bottom > rect.top && r.top < rect.bottom) {
          const n = Number(row.getAttribute("data-verse"));
          if (Number.isFinite(n)) last = n;
        }
      }
      return last;
    }

    // Inside the reader: row containing Y, else nearest mid-Y.
    let best: number | null = null;
    let bestDist = Infinity;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        const n = Number(row.getAttribute("data-verse"));
        return Number.isFinite(n) ? n : null;
      }
      const mid = (r.top + r.bottom) / 2;
      const d = Math.abs(clientY - mid);
      if (d < bestDist) {
        bestDist = d;
        const n = Number(row.getAttribute("data-verse"));
        if (Number.isFinite(n)) best = n;
      }
    }
    return best;
  }, []);

  const extendDragToPoint = useCallback(
    (clientX: number, clientY: number) => {
      const anchor = dragAnchorRef.current;
      if (anchor == null) return;
      const m = verseAtPoint(clientX, clientY);
      if (m == null) return;
      selectRangeFrom(anchor, m);
    },
    [selectRangeFrom, verseAtPoint],
  );

  /**
   * Continuous rAF loop for the whole drag. While the pointer sits in the
   * top/bottom edge band, scroll the reader; every frame re-resolve the
   * verse under the pointer so the range grows as new rows enter view.
   */
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current != null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const tickAutoScroll = useCallback(() => {
    const anchor = dragAnchorRef.current;
    const pt = dragPointRef.current;
    const reader = readerRef.current;
    if (anchor == null || !pt || !reader) {
      autoScrollRafRef.current = null;
      return;
    }

    const rect = reader.getBoundingClientRect();
    // Generous band so "slow drag near the bottom" is easy to hold.
    const EDGE = 48;
    const MAX_PX = 16;
    let dy = 0;
    if (pt.y < rect.top + EDGE) {
      const t = Math.min(1, Math.max(0, (rect.top + EDGE - pt.y) / EDGE));
      // Quadratic ease: gentle near the boundary, faster deeper in.
      dy = -Math.max(1, Math.round(MAX_PX * t * t));
    } else if (pt.y > rect.bottom - EDGE) {
      const t = Math.min(1, Math.max(0, (pt.y - (rect.bottom - EDGE)) / EDGE));
      dy = Math.max(1, Math.round(MAX_PX * t * t));
    }

    if (dy !== 0) {
      // Direct scrollTop write — no smooth-scroll, no scrollIntoView.
      reader.scrollTop += dy;
    }
    extendDragToPoint(pt.x, pt.y);

    // Keep looping for the whole drag (not only while scrolling). Holding
    // still in the edge band must keep advancing without further pointermove.
    autoScrollRafRef.current = requestAnimationFrame(tickAutoScroll);
  }, [extendDragToPoint]);

  const startAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current != null) return;
    autoScrollRafRef.current = requestAnimationFrame(tickAutoScroll);
  }, [tickAutoScroll]);

  /**
   * Drag-to-select (and shift-click extend). pointerdown plants the anchor;
   * a continuous rAF loop handles edge auto-scroll + range extend; pointerup
   * commits. A no-move press collapses to a single verse — same as a click.
   */
  const onVersePointerDown = (n: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    // Only primary button / touch; right-click is unused here.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const cur = structuredRef.current;
    if (e.shiftKey && cur.startVerse != null) {
      // Shift-click: keep existing start, extend end — no drag session.
      selectRangeFrom(cur.startVerse, n);
      return;
    }

    dragAnchorRef.current = n;
    dragPointRef.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    selectRangeFrom(n, n);

    const onMove = (ev: PointerEvent) => {
      if (dragAnchorRef.current == null) return;
      dragPointRef.current = { x: ev.clientX, y: ev.clientY };
      // Hit-test immediately for snappy mid-list drags; the rAF loop covers
      // edge hold + auto-scroll.
      extendDragToPoint(ev.clientX, ev.clientY);
    };
    const onScroll = () => {
      // Wheel/trackpad mid-drag: re-resolve under the last known pointer.
      const pt = dragPointRef.current;
      if (!pt || dragAnchorRef.current == null) return;
      extendDragToPoint(pt.x, pt.y);
    };
    const onUp = () => {
      dragAnchorRef.current = null;
      dragPointRef.current = null;
      stopAutoScroll();
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      readerRef.current?.removeEventListener("scroll", onScroll);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    readerRef.current?.addEventListener("scroll", onScroll, { passive: true });
    // Continuous loop for the whole drag — edge hold scrolls without
    // needing further pointer motion.
    startAutoScroll();
  };

  const left = Math.max(8, Math.min(x, window.innerWidth - 336));
  const top = Math.max(8, Math.min(y, window.innerHeight - 360));

  const startVerse = structured.startVerse;
  const endVerse = structured.endVerse;

  return createPortal(
    <form
      ref={ref}
      role="dialog"
      aria-label="Edit Bible reference"
      data-bible-passage-popover
      className="bg-popover fixed z-50 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-lg border p-2.5 shadow-md"
      style={{ left, top }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!normalized) return;
        onSubmit(draft);
        closeAndRefocus();
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
          aria-activedescendant={activeSuggestionId}
          aria-label="Passage"
          placeholder="John 3:16"
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (suggestions.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveSuggestion((i) => (i + 1) % suggestions.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveSuggestion(
                (i) => (i - 1 + suggestions.length) % suggestions.length,
              );
            } else if (e.key === "Enter" && activeSuggestion >= 0) {
              e.preventDefault();
              applySuggestion(activeSuggestion);
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open passage"
          disabled={!normalized}
          onClick={openCurrent}
        >
          <ExternalLink className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {suggestions.length > 0 ? (
        <div
          id={suggestionsId}
          role="listbox"
          className="border-border/70 bg-muted/30 flex max-h-28 flex-col gap-0.5 overflow-auto rounded-md border p-1"
          data-bible-passage-suggestions
        >
          {suggestions.map((suggestion, index) => {
            const active = index === activeSuggestion;
            return (
              <button
                key={`${suggestion.kind}:${suggestion.canonical}`}
                id={`${suggestionsId}-${index}`}
                role="option"
                aria-selected={active}
                type="button"
                // Active/hover needs a hard contrast jump off `bg-muted/30` —
                // accent alone was nearly invisible. Primary fill matches the
                // selected-verse treatment elsewhere in this popover.
                className={
                  active
                    ? "bg-primary text-primary-foreground flex h-7 items-center justify-between rounded-sm px-2 text-left text-xs font-medium outline-none"
                    : "text-foreground hover:bg-muted flex h-7 items-center justify-between rounded-sm px-2 text-left text-xs outline-none"
                }
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={() => setDraft(suggestion.insertText)}
              >
                <span>{suggestion.label}</span>
                <span
                  className={
                    active
                      ? "text-primary-foreground/75 text-[10px] capitalize"
                      : "text-muted-foreground text-[10px] capitalize"
                  }
                >
                  {suggestion.kind}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {chapterReady ? (
        <div
          ref={readerRef}
          role="listbox"
          aria-label="Passage text"
          data-bible-passage-reader
          data-dragging={dragging ? "true" : undefined}
          className={
            dragging
              ? "border-border/70 bg-background max-h-48 cursor-text select-none overflow-y-auto rounded-md border px-1.5 py-1.5"
              : "border-border/70 bg-background max-h-48 select-none overflow-y-auto rounded-md border px-1.5 py-1.5"
          }
        >
          {bsbStatus === "loading" ? (
            <p className="text-muted-foreground py-3 text-center text-xs">
              Loading BSB…
            </p>
          ) : bsbStatus === "empty" || !verses ? (
            <p className="text-muted-foreground py-3 text-center text-xs">
              BSB text unavailable
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {verses.map((v) => {
                const selected = isInRange(v.n, startVerse, endVerse);
                return (
                  <button
                    key={v.n}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-verse={v.n}
                    data-selected={selected ? "true" : undefined}
                    // Original highlight grammar (text tint, not a filled slab),
                    // with a wider contrast gap than the first pass:
                    // selected = primary + medium; context = ~45% muted.
                    className={
                      selected
                        ? "text-primary grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1.5 rounded-sm px-0.5 py-0.5 text-left text-xs leading-snug font-medium outline-none hover:bg-primary/5 focus-visible:ring-ring/50 focus-visible:ring-2"
                        : "text-muted-foreground/45 hover:text-muted-foreground/80 grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1.5 rounded-sm px-0.5 py-0.5 text-left text-xs leading-snug outline-none hover:bg-muted/30 focus-visible:ring-ring/50 focus-visible:ring-2"
                    }
                    onPointerDown={(e) => onVersePointerDown(v.n, e)}
                    // While dragging, entering a verse also extends the range
                    // (backup to window pointermove, which can miss mid-scroll).
                    onPointerEnter={() => {
                      const anchor = dragAnchorRef.current;
                      if (anchor == null) return;
                      selectRangeFrom(anchor, v.n);
                    }}
                    // Click is handled by pointerdown (avoids double-fire after
                    // a drag). Keep a no-op preventDefault so form doesn't
                    // treat Enter-activate oddly.
                    onClick={(e) => e.preventDefault()}
                  >
                    <span
                      className={
                        selected
                          ? "text-primary/80 pt-px text-right text-[10px] font-semibold tabular-nums"
                          : "text-muted-foreground/35 pt-px text-right text-[10px] tabular-nums"
                      }
                      aria-hidden="true"
                    >
                      {v.n}
                    </span>
                    <span className="min-w-0">{v.t}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="text-muted-foreground min-w-0 truncate text-[10px]">
          {normalized
            ? chapterReady
              ? "BSB · drag or shift-click a range"
              : normalized.label
            : "No matching passage"}
        </div>
        <div className="flex shrink-0 justify-end gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={closeAndRefocus}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!normalized}>
            Done
          </Button>
        </div>
      </div>
    </form>,
    document.body,
  );
}
