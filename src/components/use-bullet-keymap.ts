import { useHotkeys, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import type { RefObject } from "react";
import type { Node } from "../data/schema";
import { keymapSpecs, tryCaretBackspace } from "../plugins/registry";
import type { PluginContext } from "../plugins/types";
import { getCaretOffset } from "./inline-code";
import type { NodeCommands } from "./node-commands";

interface BulletKeymapArgs {
  node: Node;
  textRef: RefObject<HTMLSpanElement | null>;
  commands: NodeCommands;
  pluginCtx: () => PluginContext;
  hasChildren: boolean;
  // While a "/" or "#" menu is open it owns Arrow/Enter/Tab/Esc, so the keymap
  // disables itself. Disabled registrations bail before any preventDefault/
  // stopPropagation, leaving the menu's own onKeyDown untouched.
  enabled: boolean;
}

/**
 * Outline keyboard shortcuts, scoped to ONE bullet's contentEditable via
 * `target: textRef`. Scoping to the element is what lets single keys
 * (Enter/Tab/Backspace/Arrows) fire from a contentEditable -- the manager only
 * ignores input elements that aren't the registration's own target.
 *
 * Extracted from OutlineNodeBody so the body stays readable; the wiring is
 * unchanged. Caret-conditional keys (Backspace/Arrows) opt out of the default
 * preventDefault/stopPropagation and call them manually only when they actually
 * act, so normal in-line editing and caret movement still work.
 */
export function useBulletKeymap({
  node,
  textRef,
  commands,
  pluginCtx,
  hasChildren,
  enabled,
}: BulletKeymapArgs) {
  useHotkeys(
    [
      // Plugin per-bullet keymap (Seam D): hotkeys a plugin owns while this
      // bullet is focused -- todos' Mod+Enter / Mod+D toggle completion. They
      // run with pluginCtx() at event time; the registry guards them against the
      // core's reserved keys. Same `enabled` gate as the rest, so a menu's
      // Arrow/Enter takes precedence while open.
      ...keymapSpecs.map((k) => ({
        // KeymapSpec.hotkey is a plain string (plugin contract stays library-
        // agnostic); the manager wants its RegisterableHotkey union here.
        hotkey: k.hotkey as UseHotkeyDefinition["hotkey"],
        callback: () => k.run(node.id, pluginCtx()),
      })),
      {
        // Enter: split the bullet at the caret -- text left of the caret stays,
        // text to its right moves into a new sibling below (caret at the end is
        // just the empty-tail case of the same split).
        hotkey: "Enter",
        callback: () => {
          const el = textRef.current;
          commands.onEnter(node.id, el ? getCaretOffset(el) : node.text.length);
        },
      },
      {
        // Shift+Enter: same as Enter -- split into a sibling, never insert a
        // literal newline. Captured explicitly so the contentEditable's
        // default line break can't fire; bullets are single-line.
        hotkey: "Shift+Enter",
        callback: () => {
          const el = textRef.current;
          commands.onEnter(node.id, el ? getCaretOffset(el) : node.text.length);
        },
      },
      {
        // Tab: indent under the previous sibling.
        hotkey: "Tab",
        callback: () => commands.onIndent(node.id),
      },
      {
        // Shift+Tab: outdent one level.
        hotkey: "Shift+Tab",
        callback: () => commands.onOutdent(node.id),
      },
      {
        // Cmd/Ctrl+Shift+Up: move this bullet up among its siblings; at the
        // top edge it reparents into the parent's previous sibling. Default
        // options always preventDefault, so macOS "extend selection to doc start"
        // never fires inside the outline. See ADR 0009.
        hotkey: "Mod+Shift+ArrowUp",
        callback: () => commands.onMoveUp(node.id),
      },
      {
        // Cmd/Ctrl+Shift+Down: move down; at the bottom edge it reparents into
        // the parent's next sibling. Mirror of Mod+Shift+ArrowUp.
        hotkey: "Mod+Shift+ArrowDown",
        callback: () => commands.onMoveDown(node.id),
      },
      {
        // Backspace at the start of a bullet. Plugins may intercept first
        // (todos' checkbox demotion via caretKeys); otherwise an empty plain
        // bullet deletes and focuses the previous one.
        hotkey: "Backspace",
        callback: (e) => {
          const el = textRef.current;
          if (!el || !isCaretAtStart(el)) return;
          if (tryCaretBackspace(node, pluginCtx())) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (el.textContent !== "") return;
          e.preventDefault();
          e.stopPropagation();
          commands.onDeleteNode(node.id);
        },
        options: { preventDefault: false, stopPropagation: false },
      },
      {
        // Cmd/Ctrl+Shift+Delete: delete this bullet and its whole subtree,
        // regardless of text or caret position. On Mac "delete" is the
        // Backspace key; register Delete too for the forward-delete key.
        hotkey: "Mod+Shift+Backspace",
        callback: () => commands.onDeleteNode(node.id),
      },
      {
        hotkey: "Mod+Shift+Delete",
        callback: () => commands.onDeleteNode(node.id),
      },
      {
        // ArrowUp on the first visual line: move to the previous node,
        // preserving the caret's column (its x). Within a wrapped bullet the
        // browser default handles line-1 <- line-2 itself.
        hotkey: "ArrowUp",
        callback: (e) => {
          const el = textRef.current;
          if (!el || !atLineStart(el)) return;
          e.preventDefault();
          e.stopPropagation();
          commands.onMoveFocus(node.id, "up", caretLineRect()?.left);
        },
        options: { preventDefault: false, stopPropagation: false },
      },
      {
        // ArrowDown on the last visual line: move to the next node, preserving
        // the caret's column (its x).
        hotkey: "ArrowDown",
        callback: (e) => {
          const el = textRef.current;
          if (!el || !atLineEnd(el)) return;
          e.preventDefault();
          e.stopPropagation();
          commands.onMoveFocus(node.id, "down", caretLineRect()?.left);
        },
        options: { preventDefault: false, stopPropagation: false },
      },
      {
        // Cmd/Ctrl+Down: open (reveal the children of) a closed bullet that
        // has children. Direction encodes intent -- Down only ever opens.
        // Default options preventDefault, so the caret never jumps to the end
        // of the line; the toggle itself is conditional, making this a silent
        // no-op on an already-open or childless bullet. See ADR 0007.
        hotkey: "Mod+ArrowDown",
        callback: () => {
          if (hasChildren && node.collapsed)
            commands.onToggleCollapsed(node.id, false);
        },
      },
      {
        // Cmd/Ctrl+Up: close (collapse) an open bullet that has children.
        // Mirror of Mod+ArrowDown -- Up only ever closes; otherwise a no-op.
        hotkey: "Mod+ArrowUp",
        callback: () => {
          if (hasChildren && !node.collapsed)
            commands.onToggleCollapsed(node.id, true);
        },
      },
      {
        // Cmd/Ctrl+.: zoom this node to become the temporary root.
        hotkey: "Mod+.",
        callback: () => commands.onZoom(node.id),
      },
    ],
    { target: textRef, enabled },
  );
}

// Caret at the very start of the bullet, measured by absolute offset so the
// test holds whether the line is one text node or split around chips.
function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  return getCaretOffset(el) === 0;
}

// Caret-to-neighbor navigation is about VISUAL lines, not text offset: on a
// single-line bullet the caret is on both the first and last line at once, so
// Up/Down should always cross to the neighbor regardless of where in the text
// it sits. Only a wrapped (multi-line) bullet should move the caret within
// itself first. We detect this from the caret's rect vs the element's rect.
function caretLineRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  // A collapsed caret at a text-node boundary can report an empty rect in some
  // browsers; fall back to its first client rect.
  if (rect.height === 0) {
    const first = range.getClientRects()[0];
    if (first) rect = first;
  }
  return rect.height === 0 ? null : rect;
}

function atLineStart(el: HTMLElement): boolean {
  const rect = caretLineRect();
  // No measurable caret (e.g. empty bullet) -> treat as the first line so Up
  // crosses to the neighbor.
  if (!rect) return true;
  return rect.top - el.getBoundingClientRect().top < rect.height / 2;
}

function atLineEnd(el: HTMLElement): boolean {
  const rect = caretLineRect();
  if (!rect) return true;
  return el.getBoundingClientRect().bottom - rect.bottom < rect.height / 2;
}
