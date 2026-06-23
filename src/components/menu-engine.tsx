import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { Node } from "../data/schema";
import type {
  MenuEntry,
  MenuSpec,
  MenuTrigger,
  PluginContext,
} from "../plugins/types";
import { menuSpecs } from "../plugins/registry";
import { caretOffset, caretPosition, wrap } from "./slash-menu";
import { decorate, readSource, setCaretOffset } from "./inline-code";

/**
 * The generic caret-menu engine (ADR 0018 Seam H). One per focused bullet --
 * only the focused bullet has a caret, so at most one menu is open across the
 * whole outline. It owns the machinery every menu shares: detect a live trigger
 * before the caret, portal the option list at the caret, drive arrow/enter/tab/
 * escape, and splice the picked entry's replacement into the SOURCE (folded
 * links keep their url -- we work in readSource space, never textContent). The
 * per-menu behavior (which trigger, which entries) is a plugin `MenuSpec`.
 *
 * Mirrors the old useTagMenu/useSlashMenu shape so OutlineNode wires it in the
 * same way; the `#` tag menu now lives in the tags plugin.
 */

interface MenuOpen {
  specId: string;
  trigger: MenuTrigger;
  activeIndex: number;
  x: number;
  y: number;
}

// The default trigger detector: the trigger sits at start-or-after-whitespace
// and the query after it is whitespace-free. A spec can override `match` for a
// stricter query (tags require tag-chars). ` ` is a non-breaking space,
// which contentEditable can insert.
function defaultMatch(trigger: string) {
  return (before: string): MenuTrigger | null => {
    const triggerIndex = before.lastIndexOf(trigger);
    if (triggerIndex === -1) return null;
    const prev = before[triggerIndex - 1];
    if (triggerIndex > 0 && prev !== " " && prev !== " ") return null;
    const query = before.slice(triggerIndex + 1);
    if (/\s/.test(query)) return null;
    return { query, triggerIndex };
  };
}

export function useMenus({
  node,
  getEl,
  ctx,
  onTextChange,
}: {
  node: Node;
  getEl: () => HTMLElement | null;
  /** The PluginContext factory (read live values at event time). */
  ctx: () => PluginContext;
  onTextChange: (text: string) => void;
}) {
  const [open, setOpen] = useState<MenuOpen | null>(null);

  const spec: MenuSpec | null = open
    ? (menuSpecs.find((s) => s.id === open.specId) ?? null)
    : null;

  // The entries for the open menu, recomputed as the query changes. Reads the
  // live tree/commands through ctx(); keyed on the open state + this node.
  const entries = useMemo<MenuEntry[]>(() => {
    if (!open || !spec) return [];
    return spec.entries(open.trigger, node, ctx());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, spec, node]);

  // "Open" only counts when there's something to show (or the spec opts into an
  // empty state), so a brand-new `#tag`'s Enter is never swallowed.
  const isOpen = open !== null && (entries.length > 0 || !!spec?.openWhenEmpty);

  const close = useCallback(() => setOpen(null), []);

  // Re-evaluate the triggers after every input. The first spec whose trigger is
  // live AND has something to open wins; otherwise the menu closes.
  const handleInput = useCallback(() => {
    const el = getEl();
    if (!el) return setOpen(null);
    const caret = caretOffset(el);
    if (caret === null) return setOpen(null);
    const before = readSource(el).slice(0, caret);
    for (const s of menuSpecs) {
      const match = (s.match ?? defaultMatch(s.trigger))(before);
      if (!match) continue;
      const ents = s.entries(match, node, ctx());
      if (ents.length === 0 && !s.openWhenEmpty) continue;
      const pos = caretPosition(el);
      setOpen((prev) => ({
        specId: s.id,
        trigger: match,
        // Keep the highlight stable while typing unless the query changed.
        activeIndex:
          prev && prev.specId === s.id && prev.trigger.query === match.query
            ? prev.activeIndex
            : 0,
        x: pos.x,
        y: pos.y,
      }));
      return;
    }
    setOpen(null);
  }, [getEl, node, ctx]);

  const pick = useCallback(
    (index: number) => {
      const el = getEl();
      if (!el || !open) return;
      const entry = entries[index];
      if (!entry) return setOpen(null);
      // Splice the replacement over the trigger + query span, in SOURCE space so
      // a folded link elsewhere on the line keeps its url. The engine owns this;
      // the entry just says what to insert + where the caret lands + an optional
      // side effect (a slash command's mutation).
      const source = readSource(el);
      const t = open.trigger;
      const end = t.triggerIndex + 1 + t.query.length;
      const newText =
        source.slice(0, t.triggerIndex) + entry.replacement + source.slice(end);
      const caret = t.triggerIndex + (entry.caret ?? entry.replacement.length);
      onTextChange(newText);
      decorate(el, newText, caret, false);
      setCaretOffset(el, caret);
      setOpen(null);
      entry.after?.();
    },
    [getEl, open, entries, onTextChange],
  );

  // Intercept navigation keys while open. Returns true if it consumed the event,
  // so the caller skips its own Enter/Tab/Arrow handling.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>): boolean => {
      if (!isOpen || !open) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setOpen((s) =>
            s
              ? { ...s, activeIndex: wrap(s.activeIndex + 1, entries.length) }
              : s,
          );
          return true;
        case "ArrowUp":
          e.preventDefault();
          setOpen((s) =>
            s
              ? { ...s, activeIndex: wrap(s.activeIndex - 1, entries.length) }
              : s,
          );
          return true;
        case "Enter":
        case "Tab":
          e.preventDefault();
          pick(open.activeIndex);
          return true;
        case "Escape":
          e.preventDefault();
          setOpen(null);
          return true;
        default:
          return false;
      }
    },
    [isOpen, open, entries.length, pick],
  );

  const menu =
    isOpen && open
      ? createPortal(
          <MenuList
            entries={entries}
            activeIndex={open.activeIndex}
            emptyLabel={spec?.emptyLabel}
            x={open.x}
            y={open.y}
            onHover={(i) =>
              setOpen((s) => (s ? { ...s, activeIndex: i } : s))
            }
            onSelect={pick}
          />,
          document.body,
        )
      : null;

  return { handleInput, handleKeyDown, close, isOpen, menu };
}

function MenuList({
  entries,
  activeIndex,
  emptyLabel,
  x,
  y,
  onHover,
  onSelect,
}: {
  entries: MenuEntry[];
  activeIndex: number;
  emptyLabel?: string;
  x: number;
  y: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      className="bg-popover text-popover-foreground fixed z-50 max-h-72 w-64 overflow-y-auto rounded-md border p-1 shadow-md"
      style={{ left: x, top: y + 6 }}
    >
      {entries.length === 0 ? (
        <div className="text-muted-foreground px-2 py-1.5 text-sm">
          {emptyLabel ?? "No results"}
        </div>
      ) : (
        entries.map((entry, i) => (
          <button
            key={entry.key}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
              i === activeIndex && "bg-accent text-accent-foreground",
            )}
            // mousedown (not click) so the contentEditable keeps focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(i);
            }}
            onMouseEnter={() => onHover(i)}
          >
            {entry.render(i === activeIndex)}
          </button>
        ))
      )}
    </div>
  );
}
