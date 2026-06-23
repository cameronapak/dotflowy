import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { caretOffset, caretPosition, wrap } from "./slash-menu";
import { decorate, readSource, setCaretOffset } from "./inline-code";

/**
 * Tag autocomplete for a single bullet's contentEditable span. Mirrors
 * useSlashMenu (detect a trigger before the caret, portal a menu at the caret,
 * arrow/enter/tab/escape, mousedown-to-keep-focus) but triggers on `#` and
 * completes an existing tag. New tags are made by just finishing typing -- no
 * "create" row in v1. See docs/adr/0015.
 *
 * The menu lists existing tags across the whole outline (`getAllTags`), each
 * rendered as its colored chip. It only opens when there's at least one match,
 * so a brand-new tag never pops an empty box.
 */
interface TagState {
  query: string;
  hashIndex: number;
  activeIndex: number;
  x: number;
  y: number;
}

const TAG_CHARS = /^[\p{L}\p{N}_-]+$/u;

export function useTagMenu({
  getEl,
  getAllTags,
  onTextChange,
}: {
  getEl: () => HTMLElement | null;
  getAllTags: () => string[];
  onTextChange: (text: string) => void;
}) {
  const [state, setState] = useState<TagState | null>(null);

  const items = useMemo(() => {
    if (!state) return [];
    const q = state.query.toLowerCase();
    const all = getAllTags();
    const matches = q
      ? all.filter((t) => t.slice(1).toLowerCase().includes(q))
      : all;
    return matches.slice(0, 8);
    // Recompute as the query changes; getAllTags reads the live index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // The menu only counts as "open" when it has something to show, so an empty
  // box never swallows Enter from a brand-new tag.
  const isOpen = state !== null && items.length > 0;

  const close = useCallback(() => setState(null), []);

  const handleInput = useCallback(() => {
    const el = getEl();
    if (!el) return;
    const hit = detectTag(el);
    if (!hit) {
      setState(null);
      return;
    }
    const pos = caretPosition(el);
    setState((prev) => ({
      query: hit.query,
      hashIndex: hit.hashIndex,
      activeIndex: prev && prev.query === hit.query ? prev.activeIndex : 0,
      x: pos.x,
      y: pos.y,
    }));
  }, [getEl]);

  const select = useCallback(
    (index: number) => {
      const el = getEl();
      if (!el || !state) return;
      const tag = items[index];
      if (!tag) {
        setState(null);
        return;
      }
      // Replace the "#query" the user typed with the full tag + a trailing
      // space (so it's "finished"), in SOURCE space so a folded link on the
      // line keeps its url. Re-decorate into a chip, then place the caret.
      const text = readSource(el);
      const end = state.hashIndex + 1 + state.query.length;
      const newText = text.slice(0, state.hashIndex) + tag + " " + text.slice(end);
      const caret = state.hashIndex + tag.length + 1;
      onTextChange(newText);
      decorate(el, newText, caret, false);
      setCaretOffset(el, caret);
      setState(null);
    },
    [getEl, state, items, onTextChange],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>): boolean => {
      if (!isOpen || !state) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setState((s) =>
            s ? { ...s, activeIndex: wrap(s.activeIndex + 1, items.length) } : s,
          );
          return true;
        case "ArrowUp":
          e.preventDefault();
          setState((s) =>
            s ? { ...s, activeIndex: wrap(s.activeIndex - 1, items.length) } : s,
          );
          return true;
        case "Enter":
        case "Tab":
          e.preventDefault();
          select(state.activeIndex);
          return true;
        case "Escape":
          e.preventDefault();
          setState(null);
          return true;
        default:
          return false;
      }
    },
    [isOpen, state, items.length, select],
  );

  const menu = isOpen
    ? createPortal(
        <TagMenu
          items={items}
          activeIndex={state.activeIndex}
          x={state.x}
          y={state.y}
          onHover={(i) => setState((s) => (s ? { ...s, activeIndex: i } : s))}
          onSelect={select}
        />,
        document.body,
      )
    : null;

  return { handleInput, handleKeyDown, close, isOpen, menu };
}

function TagMenu({
  items,
  activeIndex,
  x,
  y,
  onHover,
  onSelect,
}: {
  items: string[];
  activeIndex: number;
  x: number;
  y: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      className="bg-popover text-popover-foreground fixed z-50 max-h-72 w-56 overflow-y-auto rounded-md border p-1 shadow-md"
      style={{ left: x, top: y + 6 }}
    >
      {items.map((tag, i) => (
        <button
          key={tag}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={cn(
            "flex w-full items-center rounded-sm px-2 py-1.5 text-left",
            i === activeIndex && "bg-accent",
          )}
          // mousedown (not click) so the contentEditable keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(i);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="tag-option" data-tag={tag.slice(1)}>
            {tag}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Inspect the text before the caret for an open `#` tag. Triggers only when the
 * `#` is at the start of the bullet or follows whitespace (so `a#b` doesn't
 * fire), and the query after it is all tag characters (no space/punctuation).
 */
function detectTag(
  el: HTMLElement,
): { query: string; hashIndex: number } | null {
  const caret = caretOffset(el);
  if (caret === null) return null;
  const before = readSource(el).slice(0, caret);
  const hashIndex = before.lastIndexOf("#");
  if (hashIndex === -1) return null;
  const prev = before[hashIndex - 1];
  if (hashIndex > 0 && prev !== " " && prev !== " ") return null;
  const query = before.slice(hashIndex + 1);
  if (query.length > 0 && !TAG_CHARS.test(query)) return null;
  return { query, hashIndex };
}
