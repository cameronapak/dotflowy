import {
  getMaxChapter,
  getMaxVerse,
  OSIS_BOOK_CODES,
  OSIS_BOOK_NAMES,
  tryParsePassage,
  type OsisBookCode,
} from "grab-bcv";
import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getTreeIndex } from "../../data/tree-store";
import type { NodeCommands } from "../../components/OutlineNode";
import { Button, Input } from "../kit";
import type { PluginContext } from "../types";
import {
  formatStructuredBibleRef,
  normalizeBibleRef,
  replaceBibleRefToken,
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
      start.verse != null && end.book === start.book && end.chapter === start.chapter
        ? (end.verse ?? start.verse)
        : null,
  };
}

function selectClassName(extra = ""): string {
  return `border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 min-w-0 rounded-lg border px-2 text-sm outline-none transition-colors focus-visible:ring-3 ${extra}`;
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
  if (newToken === oldToken) return;
  const index = getTreeIndex();
  const clicked = index.byId.get(nodeId);
  if (!clicked) return;
  const targetId = clicked.mirrorOf ?? nodeId;
  const current = index.byId.get(targetId)?.text;
  if (current == null) return;
  const next = replaceBibleRefToken(current, oldToken, newToken);
  if (next != null && next !== current) mutations.onTextChange(targetId, next);
}

export function openBiblePassageEditPopover(
  args: {
    nodeId: string;
    token: string;
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
  onSubmit,
  onClose,
}: {
  token: string;
  x: number;
  y: number;
  onSubmit: (input: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLFormElement | null>(null);
  const initialStructured = structuredFromInput(token);
  const [draft, setDraft] = useState(token);
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

  useEffect(() => {
    const next = structuredFromInput(draft);
    if (next) setStructured(next);
  }, [draft]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
  }, [onClose]);

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

  const left = Math.max(8, Math.min(x, window.innerWidth - 368));
  const top = Math.max(8, Math.min(y, window.innerHeight - 308));

  return createPortal(
    <form
      ref={ref}
      role="dialog"
      aria-label="Edit Bible reference"
      data-bible-passage-popover
      className="bg-popover fixed z-50 flex w-[22rem] max-w-[calc(100vw-1rem)] flex-col gap-3 rounded-lg border p-3 shadow-md"
      style={{ left, top }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!normalized) return;
        onSubmit(draft);
        onClose();
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Passage"
          placeholder="John 3:16"
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
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
        <div className="flex flex-col gap-1" data-bible-passage-suggestions>
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.kind}:${suggestion.canonical}`}
              type="button"
              className="hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground flex h-8 items-center justify-between rounded-md px-2 text-left text-sm outline-none"
              onClick={() => setDraft(suggestion.insertText)}
            >
              <span>{suggestion.label}</span>
              <span className="text-muted-foreground text-xs capitalize">
                {suggestion.kind}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1.4fr)_4.5rem_4.5rem_4.5rem] gap-2">
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
          <option value="">All</option>
          {numbers(maxVerse).map((verse) => (
            <option key={verse} value={verse}>
              {verse}
            </option>
          ))}
        </select>

        <select
          aria-label="End verse"
          className={selectClassName()}
          disabled={startVerse == null}
          value={endVerse ?? startVerse ?? ""}
          onChange={(e) =>
            applyStructured({
              ...structured,
              endVerse: Number(e.currentTarget.value),
            })
          }
        >
          {startVerse == null ? (
            <option value="">All</option>
          ) : (
            numbers(maxVerse - startVerse + 1).map((i) => {
              const verse = startVerse + i - 1;
              return (
                <option key={verse} value={verse}>
                  {verse}
                </option>
              );
            })
          )}
        </select>
      </div>

      <div className="text-muted-foreground min-h-4 truncate text-xs">
        {normalized ? normalized.label : "No matching passage"}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!normalized}>
          Done
        </Button>
      </div>
    </form>,
    document.body,
  );
}
