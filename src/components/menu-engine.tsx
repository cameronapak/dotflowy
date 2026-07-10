import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { Node } from "../data/schema";
import type {
  MenuEntry,
  MenuSpec,
  MenuTrigger,
  PluginContext,
} from "../plugins/types";

import { menuSpecs } from "../plugins/registry";
import { caretOffset, caretPosition, wrap } from "./caret-menu-utils";
import { decorate, readSource, setCaretOffset } from "./inline-code";
import { MenuList } from "./menu-list";

/**
 * The generic caret-menu engine (ADR 0001 Seam H). One per focused bullet --
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
// stricter query (tags require tag-chars). The preceding-char test uses `\s`
// so it also accepts the non-breaking space (U+00A0) contentEditable inserts.
function defaultMatch(trigger: string) {
  return (before: string): MenuTrigger | null => {
    const triggerIndex = before.lastIndexOf(trigger);
    if (triggerIndex === -1) return null;
    const prev = before[triggerIndex - 1];
    if (triggerIndex > 0 && !/\s/.test(prev ?? "")) return null;
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
  // live tree/commands through ctx() (a referentially-stable factory).
  const entries: MenuEntry[] =
    open && spec ? spec.entries(open.trigger, node, ctx()) : [];

  // "Open" only counts when there's something to show (or the spec opts into an
  // empty state), so a brand-new `#tag`'s Enter is never swallowed.
  const isOpen = open !== null && (entries.length > 0 || !!spec?.openWhenEmpty);

  const close = () => setOpen(null);

  // Re-evaluate the triggers after every input. The first spec whose trigger is
  // live AND has something to open wins; otherwise the menu closes.
  const handleInput = () => {
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
  };

  const pick = (index: number) => {
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
  };

  // Intercept navigation keys while open. Returns true if it consumed the event,
  // so the caller skips its own Enter/Tab/Arrow handling.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
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
  };

  const menu =
    isOpen && open
      ? createPortal(
          <MenuList
            entries={entries}
            activeIndex={open.activeIndex}
            emptyLabel={spec?.emptyLabel}
            x={open.x}
            y={open.y}
            onHover={(i) => setOpen((s) => (s ? { ...s, activeIndex: i } : s))}
            onSelect={pick}
          />,
          document.body,
        )
      : null;

  return { handleInput, handleKeyDown, close, isOpen, menu };
}
