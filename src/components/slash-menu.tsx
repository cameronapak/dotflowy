import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ListIcon,
  SquareCheckIcon,
  CornerUpRightIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Node } from "../data/schema";
import type { NodeCommands } from "./OutlineNode";

/**
 * A single entry in the `/` command menu. `available` lets a command hide
 * itself based on the current node (e.g. "To-do" disappears once the bullet
 * is already a task). `run` receives the node id and performs the action.
 */
export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  keywords: string[];
  available: (node: Node) => boolean;
  run: (nodeId: string, commands: NodeCommands) => void;
}

/**
 * The command registry. New slash commands get added here; the detection,
 * filtering, keyboard, and rendering machinery below is generic.
 */
const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "todo",
    label: "To-do",
    description: "Turn into a To-do",
    icon: SquareCheckIcon,
    keywords: ["todo", "task", "checkbox", "check", "done", "into"],
    available: (node) => !node.isTask,
    run: (id, commands) => commands.onSetTask(id, true),
  },
  {
    id: "bullet",
    label: "Bullet",
    description: "Turn into a plain bullet",
    icon: ListIcon,
    keywords: ["bullet", "plain", "text", "list", "into"],
    available: (node) => node.isTask,
    run: (id, commands) => commands.onSetTask(id, false),
  },
  {
    id: "move",
    label: "Move",
    description: "Move under another node",
    icon: CornerUpRightIcon,
    keywords: ["move", "reparent", "under", "into", "relocate", "home"],
    available: () => true,
    run: (id, commands) => commands.onRequestMove(id),
  },
];

function filterCommands(node: Node, query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const available = SLASH_COMMANDS.filter((c) => c.available(node));
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
  commands,
  getEl,
  onTextChange,
}: {
  node: Node;
  commands: NodeCommands;
  getEl: () => HTMLElement | null;
  onTextChange: (text: string) => void;
}) {
  const [state, setState] = useState<SlashState | null>(null);

  const items = useMemo(
    () => (state ? filterCommands(node, state.query) : []),
    [state, node],
  );

  const close = useCallback(() => setState(null), []);

  // Re-evaluate the trigger after every input. Opens, updates, or closes.
  const handleInput = useCallback(() => {
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
  }, [getEl]);

  const select = useCallback(
    (index: number) => {
      const el = getEl();
      if (!el || !state) return;
      const list = filterCommands(node, state.query);
      const item = list[index];
      if (!item) {
        setState(null);
        return;
      }
      // Strip the "/query" the user typed, then run the command.
      const text = el.textContent ?? "";
      const end = state.slashIndex + 1 + state.query.length;
      const newText = text.slice(0, state.slashIndex) + text.slice(end);
      el.textContent = newText;
      placeCaretAtOffset(el, state.slashIndex);
      onTextChange(newText);
      setState(null);
      item.run(node.id, commands);
    },
    [getEl, state, node, commands, onTextChange],
  );

  // Intercept navigation keys while open. Returns true if it consumed the
  // event, so the caller skips its own Enter/Tab/Arrow handling.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>): boolean => {
      if (!state) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setState((s) =>
            s
              ? { ...s, activeIndex: wrap(s.activeIndex + 1, items.length) }
              : s,
          );
          return true;
        case "ArrowUp":
          e.preventDefault();
          setState((s) =>
            s
              ? { ...s, activeIndex: wrap(s.activeIndex - 1, items.length) }
              : s,
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
    [state, items.length, select],
  );

  const menu = state
    ? createPortal(
        <SlashMenu
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

  return { handleInput, handleKeyDown, close, isOpen: !!state, menu };
}

function SlashMenu({
  items,
  activeIndex,
  x,
  y,
  onHover,
  onSelect,
}: {
  items: SlashCommand[];
  activeIndex: number;
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
      {items.length === 0 ? (
        <div className="text-muted-foreground px-2 py-1.5 text-sm">
          No commands
        </div>
      ) : (
        items.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
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
              <Icon className="size-4 shrink-0 opacity-70" />
              <span className="flex flex-col">
                <span className="font-medium">{item.label}</span>
                <span className="text-muted-foreground text-xs">
                  {item.description}
                </span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

export function wrap(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
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
  const before = (el.textContent ?? "").slice(0, caret);
  const slashIndex = before.lastIndexOf("/");
  if (slashIndex === -1) return null;
  const prev = before[slashIndex - 1];
  if (slashIndex > 0 && prev !== " " && prev !== " ") return null;
  const query = before.slice(slashIndex + 1);
  if (/\s/.test(query)) return null;
  return { query, slashIndex };
}

/** Number of characters before the collapsed caret within `el`, or null. */
export function caretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

/** Viewport coords of the caret, falling back to the element's box. */
export function caretPosition(el: HTMLElement): { x: number; y: number } {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (rect.left || rect.top || rect.height) {
      return { x: rect.left, y: rect.bottom };
    }
  }
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}

export function placeCaretAtOffset(el: HTMLElement, offset: number) {
  const range = document.createRange();
  const textNode = el.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    const max = textNode.textContent?.length ?? 0;
    range.setStart(textNode, Math.min(offset, max));
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
