import {
  getMaxChapter,
  getMaxVerse,
  OSIS_BOOK_CODES,
  OSIS_BOOK_NAMES,
  tryParsePassage,
  type OsisBookCode,
} from "grab-bcv";
import { ExternalLink } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { NodeCommands } from "../../components/node-commands";
import type { PluginContext } from "../types";

import { placeCaretAtEnd } from "../../components/caret-place";
import { Button, Input } from "../kit";
import { replaceTokenInNode } from "../token-kit";
import {
  formatStructuredBibleRef,
  normalizeBibleRef,
  suggestBibleRefs,
} from "./bible";

type StructuredPassage = {
  book: OsisBookCode;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
};

function numbers(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function structuredFromInput(input: string): StructuredPassage | null {
  const parsed = tryParsePassage(input);
  if (!parsed.ok) return null;
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

function selectClassName(extra = ""): string {
  return `border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 min-w-0 rounded-md border px-2 text-sm outline-none transition-colors focus-visible:ring-3 ${extra}`;
}

export function submitBiblePassageEdit(
  nodeId: string,
  oldToken: string,
  input: string,
  mutations: NodeCommands,
): void {
  const normalized = normalizeBibleRef(input);
  if (!normalized) return;
  const newToken = normalized.label;
  replaceTokenInNode(nodeId, oldToken, newToken, mutations);
}

export function openBiblePassageEditPopover(
  args: {
    nodeId: string;
    token: string;
    focusTarget: HTMLElement | null;
    x: number;
    y: number;
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
        submitBiblePassageEdit(args.nodeId, args.token, input, ctx.mutations)
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

  const normalized = useMemo(() => normalizeBibleRef(draft), [draft]);
  const suggestions = useMemo(() => suggestBibleRefs(draft), [draft]);
  const maxChapter = getMaxChapter(structured.book);
  const maxVerse = getMaxVerse(structured.book, structured.chapter) ?? 0;
  const startVerse = structured.startVerse;
  const endVerse = structured.endVerse;
  const activeSuggestionId =
    activeSuggestion >= 0 ? `${suggestionsId}-${activeSuggestion}` : undefined;

  useEffect(() => {
    setActiveSuggestion(suggestions.length > 0 ? 0 : -1);
  }, [suggestions]);

  useEffect(() => {
    const next = structuredFromInput(draft);
    if (next) setStructured(next);
  }, [draft]);

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

  const applyStructured = (next: StructuredPassage) => {
    const safeChapter = clamp(next.chapter, 1, getMaxChapter(next.book));
    const verseCap = getMaxVerse(next.book, safeChapter) ?? 0;
    const safeStart =
      next.startVerse == null || verseCap === 0
        ? null
        : clamp(next.startVerse, 1, verseCap);
    const safeEnd =
      safeStart == null || next.endVerse == null
        ? safeStart
        : clamp(next.endVerse, safeStart, verseCap);
    const safe = {
      book: next.book,
      chapter: safeChapter,
      startVerse: safeStart,
      endVerse: safeEnd,
    };
    setStructured(safe);
    setDraft(formatStructuredBibleRef(safe));
  };

  const openCurrent = () => {
    if (!normalized) return;
    window.open(normalized.url, "_blank", "noopener,noreferrer");
  };

  const applySuggestion = (index: number) => {
    const suggestion = suggestions[index];
    if (suggestion) setDraft(suggestion.insertText);
  };

  const left = Math.max(8, Math.min(x, window.innerWidth - 336));
  const top = Math.max(8, Math.min(y, window.innerHeight - 280));

  return createPortal(
    <form
      ref={ref}
      role="dialog"
      aria-label="Edit Bible reference"
      data-bible-passage-popover
      className="fixed z-50 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2.5 rounded-lg border bg-popover p-2.5 shadow-md"
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
          className="flex max-h-36 flex-col gap-0.5 overflow-auto rounded-md border border-border/70 bg-muted/30 p-1"
          data-bible-passage-suggestions
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.kind}:${suggestion.canonical}`}
              id={`${suggestionsId}-${index}`}
              role="option"
              aria-selected={index === activeSuggestion}
              type="button"
              className="flex h-8 items-center justify-between rounded-sm px-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground aria-selected:bg-accent aria-selected:text-accent-foreground"
              onMouseEnter={() => setActiveSuggestion(index)}
              onClick={() => setDraft(suggestion.insertText)}
            >
              <span>{suggestion.label}</span>
              <span className="text-xs text-muted-foreground capitalize">
                {suggestion.kind}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <details className="group">
        <summary className="flex h-7 cursor-pointer list-none items-center justify-between rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
          <span>Open selector</span>
          <span className="transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_4.25rem] gap-1.5">
            <select
              aria-label="Book"
              className={selectClassName()}
              value={structured.book}
              onChange={(e) =>
                applyStructured({
                  ...structured,
                  book: e.currentTarget.value as OsisBookCode,
                  chapter: 1,
                  startVerse: null,
                  endVerse: null,
                })
              }
            >
              {OSIS_BOOK_CODES.map((book) => (
                <option key={book} value={book}>
                  {OSIS_BOOK_NAMES[book]}
                </option>
              ))}
            </select>

            <select
              aria-label="Chapter"
              className={selectClassName()}
              value={structured.chapter}
              onChange={(e) =>
                applyStructured({
                  ...structured,
                  chapter: Number(e.currentTarget.value),
                  startVerse: null,
                  endVerse: null,
                })
              }
            >
              {numbers(maxChapter).map((chapter) => (
                <option key={chapter} value={chapter}>
                  {chapter}
                </option>
              ))}
            </select>
          </div>

          <div
            className={
              startVerse == null
                ? "grid grid-cols-1"
                : "grid grid-cols-[minmax(0,1fr)_4.25rem] gap-1.5"
            }
          >
            <select
              aria-label="Start verse"
              className={selectClassName()}
              value={startVerse ?? ""}
              onChange={(e) => {
                const value = e.currentTarget.value;
                const nextStart = value ? Number(value) : null;
                applyStructured({
                  ...structured,
                  startVerse: nextStart,
                  endVerse: nextStart,
                });
              }}
            >
              <option value="">All verses</option>
              {numbers(maxVerse).map((verse) => (
                <option key={verse} value={verse}>
                  {verse}
                </option>
              ))}
            </select>

            {startVerse != null ? (
              <select
                aria-label="End verse"
                className={selectClassName()}
                value={endVerse ?? startVerse}
                onChange={(e) =>
                  applyStructured({
                    ...structured,
                    endVerse: Number(e.currentTarget.value),
                  })
                }
              >
                {numbers(maxVerse - startVerse + 1).map((i) => {
                  const verse = startVerse + i - 1;
                  return (
                    <option key={verse} value={verse}>
                      {verse}
                    </option>
                  );
                })}
              </select>
            ) : null}
          </div>
        </div>
      </details>

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="min-w-0 truncate text-xs text-muted-foreground">
          {normalized ? normalized.label : "No matching passage"}
        </div>
        <div className="flex shrink-0 justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={closeAndRefocus}
          >
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
