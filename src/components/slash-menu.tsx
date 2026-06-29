import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CornerUpRightIcon } from "lucide-react";
import type { Node } from "../data/schema";
import type { CommandSpec, PluginContext } from "../plugins/types";
import { commandSpecs } from "../plugins/registry";
import { caretOffset, caretPosition, wrap } from "./caret-menu-utils";
import {
  decorate,
  readSource,
  setCaretOffset,
} from "./inline-code";
import { SlashMenuList } from "./slash-menu-list";

/**
 * The core's own slash commands. Move is structural (reparent any node), not a
 * feature concept, so it stays core; feature commands (`/todo`, `/bullet`) are
 * the todos plugin's, registered via Seam C. The whole list is plugin commands
 * (array order) THEN core, so the contextual type-change commands lead and Move
 * trails -- preserving the pre-plugin palette order.
 */
const CORE_COMMANDS: CommandSpec[] = [
  {
    id: "move",
    label: "Move",
    description: "Move under another node",
    icon: CornerUpRightIcon,
    keywords: ["move", "reparent", "under", "into", "relocate", "home"],
    available: () => true,
    run: (id, ctx) => ctx.mutations.onRequestMove(id),
  },
];

/** The composed command list driving the `/` palette: plugin commands (Seam C),
 *  then the core's. Detection/filtering/keyboard/rendering below stay generic. */
const COMMANDS: CommandSpec[] = [...commandSpecs, ...CORE_COMMANDS];

function filterCommands(node: Node, query: string): CommandSpec[] {
  const q = query.toLowerCase();
  const available = COMMANDS.filter((c) => c.available(node));
  if (!q) return available;
  return available.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.includes(q)),
  );
}

/** Open-menu state. `slashIndex` is the char offset of the triggering "/". */
interface SlashState {
  query: string;
  slashIndex: number;
  activeIndex: number;
  x: number;
  y: number;
}

/**
 * Drives the `/` command menu for a single bullet's contentEditable span.
 *
 * Returns input/keydown handlers the OutlineNode wires into its existing
 * handlers, a `close` callback (for blur), `isOpen`, and the rendered menu
 * element (portaled, so it's safe to drop anywhere in the JSX).
 */
export function useSlashMenu({
  node,
  ctx,
  getEl,
  onTextChange,
}: {
  node: Node;
  /** The PluginContext factory (read live values at event time), the same one
   *  the bullet hands to the menu engine. A picked command runs with `ctx()`. */
  ctx: () => PluginContext;
  getEl: () => HTMLElement | null;
  onTextChange: (text: string) => void;
}) {
  const [state, setState] = useState<SlashState | null>(null);

  const items = state ? filterCommands(node, state.query) : [];

  const close = () => setState(null);

  // Re-evaluate the trigger after every input. Opens, updates, or closes.
  const handleInput = () => {
    const el = getEl();
    if (!el) return;
    const hit = detectSlash(el);
    if (!hit) {
      setState(null);
      return;
    }
    const pos = caretPosition(el);
    setState((prev) => ({
      query: hit.query,
      slashIndex: hit.slashIndex,
      // Keep the highlight stable while typing unless the query changed.
      activeIndex: prev && prev.query === hit.query ? prev.activeIndex : 0,
      x: pos.x,
      y: pos.y,
    }));
  };

  const select = (index: number) => {
    const el = getEl();
    if (!el || !state) return;
    const list = filterCommands(node, state.query);
    const item = list[index];
    if (!item) {
      setState(null);
      return;
    }
    // Strip the "/query" the user typed, then run the command. Work in
    // SOURCE space (readSource, not textContent) so a folded link elsewhere
    // on the line keeps its url instead of flattening to its label.
    const text = readSource(el);
    const end = state.slashIndex + 1 + state.query.length;
    const newText = text.slice(0, state.slashIndex) + text.slice(end);
    onTextChange(newText);
    decorate(el, newText, state.slashIndex, false);
    setCaretOffset(el, state.slashIndex);
    setState(null);
    item.run(node.id, ctx());
  };

  // Intercept navigation keys while open. Returns true if it consumed the
  // event, so the caller skips its own Enter/Tab/Arrow handling.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (!state) return false;
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
  };

  const menu = state
    ? createPortal(
        <SlashMenuList
          items={items}
          activeIndex={state.activeIndex}
          style={{ position: "fixed", left: state.x, top: state.y + 6 }}
          onHover={(i) => setState((s) => (s ? { ...s, activeIndex: i } : s))}
          onSelect={select}
        />,
        document.body,
      )
    : null;

  return { handleInput, handleKeyDown, close, isOpen: !!state, menu };
}

/**
 * Inspect the text before the caret for an active "/" trigger. Triggers only
 * when the "/" is at the start of the bullet or follows whitespace (so URLs
 * like "a/b" don't fire), and the query after it has no whitespace.
 */
function detectSlash(
  el: HTMLElement,
): { query: string; slashIndex: number } | null {
  const caret = caretOffset(el);
  if (caret === null) return null;
  const before = readSource(el).slice(0, caret);
  const slashIndex = before.lastIndexOf("/");
  if (slashIndex === -1) return null;
  const prev = before[slashIndex - 1];
  if (slashIndex > 0 && prev !== " " && prev !== " ") return null;
  const query = before.slice(slashIndex + 1);
  if (/\s/.test(query)) return null;
  return { query, slashIndex };
}
