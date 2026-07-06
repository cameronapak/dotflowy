import { useHotkeys, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { useLayoutEffect, useState, type RefObject } from "react";
import type { Node } from "../data/schema";
import { dispatchClick, keymapSpecs } from "../plugins/registry";
import type { PluginContext } from "../plugins/types";
import { selectSingle } from "../data/selection-state";
import {
  getCaretOffset,
  getSelectedAtom,
  readSource,
  selectAdjacentAtom,
} from "./inline-code";
import { openLinkAtCaret } from "./link-keymap";
import type { NodeCommands } from "./OutlineNode";

interface BulletKeymapArgs {
  node: Node;
  // The INSTANCE id + its collapse state. Collapse is LOCAL to where the row
  // sits (ADR 0022 field split), so Cmd+Up/Down toggle the INSTANCE, not the
  // source. `node` is the CONTENT (slice 1b feeds a mirror row its source), so
  // keying collapse off `node.id`/`node.collapsed` would expand/collapse the
  // source instead -- exactly what the chevron (which uses `instance`) avoids.
  // For a mirror-free row instanceId === node.id, so this is byte-identical.
  instanceId: string;
  instanceCollapsed: boolean;
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
/** Stable empty keymap for unfocused bullets, so an unfocused re-render never
 *  hands `useHotkeys` a fresh array (which would re-run its registration work). */
const EMPTY_KEYMAP: never[] = [];

export function useBulletKeymap({
  node,
  instanceId,
  instanceCollapsed,
  textRef,
  commands,
  pluginCtx,
  hasChildren,
  enabled,
}: BulletKeymapArgs) {
  // Only the FOCUSED bullet needs a registered keymap: every definition is
  // `target: textRef`, so it can only fire while this bullet holds the caret.
  // Registering ~18 hotkeys for EVERY visible bullet made a zoom -- which
  // remounts the whole windowed list -- burn ~130ms in @tanstack/react-hotkeys;
  // gating registration on focus cuts that to one bullet's worth. The no-caret
  // selection keys live on a window-level listener (selection-mode.tsx), so
  // multi-select is unaffected when the bullet blurs.
  //
  // LAYOUT effect, not passive: a freshly-inserted bullet is focused in
  // OutlineRow's mount `useLayoutEffect` (the central FocusPass for already-
  // mounted rows). `useHotkeys` registers in a passive effect, so if this flip
  // ran passively too, `setFocused(true)` would land AFTER the first paint and
  // force a SECOND passive pass before the full keymap registered -- a paint
  // cycle where the just-focused bullet has no keymap (a rapid second Enter
  // could no-op). Flipping in the layout phase re-renders synchronously before
  // paint, so the keymap registers in the first passive pass -- matching the
  // pre-gating (always-on) timing.
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // Sync now: a freshly inserted bullet is focused imperatively right after
    // mount, before a 'focus' event would reach this listener.
    setFocused(document.activeElement === el);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    return () => {
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
    };
  }, [textRef]);

  useHotkeys(
    focused
      ? [
          // Plugin per-bullet keymap (Seam D): hotkeys a plugin owns while this
          // bullet is focused -- todos' Mod+Enter / Mod+D toggle completion. They
          // run with pluginCtx() at event time; the registry guards them against the
          // core's reserved keys. Same `enabled` gate as the rest, so a menu's
          // Arrow/Enter takes precedence while open.
          ...keymapSpecs.map((k) => ({
            // KeymapSpec.hotkey is a plain string (plugin contract stays library-
            // agnostic); the manager wants its RegisterableHotkey union here.
            hotkey: k.hotkey as UseHotkeyDefinition["hotkey"],
            callback: () => {
              const el = textRef.current;
              if (k.hotkey === "Mod+Enter" && el && openLinkAtCaret(el)) return;
              k.run(node.id, pluginCtx());
            },
          })),
          {
            // Enter: split the bullet at the caret -- text left of the caret stays,
            // text to its right moves into a new sibling below (caret at the end is
            // just the empty-tail case of the same split).
            hotkey: "Enter",
            callback: (e) => {
              const el = textRef.current;
              if (el) {
                const atom = getSelectedAtom(el);
                if (atom) {
                  const rect = atom.getBoundingClientRect();
                  const handled = dispatchClick(atom, pluginCtx(), {
                    preventDefault: () => e.preventDefault(),
                    stopPropagation: () => e.stopPropagation(),
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                  });
                  if (handled) return;
                }
              }
              commands.onEnter(
                node.id,
                el ? getCaretOffset(el) : node.text.length,
              );
            },
          },
          {
            // Shift+Enter: same as Enter -- split into a sibling, never insert a
            // literal newline. Captured explicitly so the contentEditable's
            // default line break can't fire; bullets are single-line.
            hotkey: "Shift+Enter",
            callback: () => {
              const el = textRef.current;
              commands.onEnter(
                node.id,
                el ? getCaretOffset(el) : node.text.length,
              );
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
            // Backspace at the start of a bullet. On a task, the first backspace
            // "deletes the checkbox" -- demoting it to a plain bullet while keeping
            // the text (mirrors the "[ ]" autoformat). On an empty plain bullet, it
            // deletes the node and focuses the previous one. Otherwise it falls
            // through to normal character deletion.
            hotkey: "Backspace",
            callback: (e) => {
              const el = textRef.current;
              if (!el || !isCaretAtStart(el)) return;
              if (node.isTask) {
                e.preventDefault();
                e.stopPropagation();
                commands.onSetTask(node.id, false);
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
            // Shift+ArrowUp from the top visual line: ENTER node multi-selection
            // (ADR 0018) on THIS node only -- the first press selects the focused
            // node; a subsequent Shift+arrow extends the run (handled while-selected
            // in selection-mode.tsx). From a wrapped bullet's interior it falls
            // through to native shift text-selection (preventDefault opted out),
            // mirroring ArrowUp's edge-line rule. Selection mode has no caret, so we
            // blur the bullet.
            hotkey: "Shift+ArrowUp",
            callback: (e) => {
              const el = textRef.current;
              if (!el || !atLineStart(el)) return;
              e.preventDefault();
              e.stopPropagation();
              // Select the INSTANCE, not the content (ADR 0022): selecting a
              // mirror by its source id would make select+delete remove the
              // source and orphan every instance. instanceId === node.id for a
              // mirror-free row.
              selectSingle(instanceId);
              el.blur();
              window.getSelection()?.removeAllRanges();
            },
            options: { preventDefault: false, stopPropagation: false },
          },
          {
            // Shift+ArrowDown from the last visual line: same single-node entry as
            // Shift+ArrowUp (entry is direction-agnostic -- it selects the focused
            // node; the next press extends). Mirror of Shift+ArrowUp's edge gate.
            hotkey: "Shift+ArrowDown",
            callback: (e) => {
              const el = textRef.current;
              if (!el || !atLineEnd(el)) return;
              e.preventDefault();
              e.stopPropagation();
              selectSingle(instanceId); // the instance, not its source (see above)
              el.blur();
              window.getSelection()?.removeAllRanges();
            },
            options: { preventDefault: false, stopPropagation: false },
          },
          {
            // Cmd/Ctrl+A -- the bounded selection ladder (ADR 0018), rung 1 -> 2.
            // Rung 1 (native): a non-empty bullet whose text isn't already fully
            // selected selects all its TEXT. Rung 2: once the text is fully selected
            // (or the bullet is empty -- rung 1 is skipped), select this NODE and its
            // subtree, entering node selection. Rung 3 (the whole view) is escalated
            // by the while-selected handler once a selection exists.
            hotkey: "Mod+A",
            callback: (e) => {
              const el = textRef.current;
              if (!el) return;
              const empty = el.textContent === "";
              if (!empty && !isAllTextSelected(el)) return; // rung 1: native select-all
              e.preventDefault();
              e.stopPropagation();
              selectSingle(instanceId); // the instance, not its source (see above)
              el.blur();
              window.getSelection()?.removeAllRanges();
            },
            options: { preventDefault: false, stopPropagation: false },
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
            // Left at the start snakes to the previous visible node's end,
            // matching the existing visible-order walk used by Up/Down.
            hotkey: "ArrowLeft",
            callback: (e) => {
              const el = textRef.current;
              if (el && selectAdjacentAtom(el, "left")) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              if (!el || !isCollapsedCaretAtStart(el)) return;
              e.preventDefault();
              e.stopPropagation();
              commands.onMoveFocus(node.id, "up");
            },
            options: { preventDefault: false, stopPropagation: false },
          },
          {
            // Right at the end snakes to the next visible node's start.
            hotkey: "ArrowRight",
            callback: (e) => {
              const el = textRef.current;
              if (el && selectAdjacentAtom(el, "right")) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              if (!el || !isCaretAtEnd(el)) return;
              e.preventDefault();
              e.stopPropagation();
              commands.onMoveFocus(node.id, "down");
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
              // Toggle the INSTANCE (collapse is local, ADR 0022): on a mirror's
              // own row this opens that mirror, leaving the source untouched.
              if (hasChildren && instanceCollapsed)
                commands.onToggleCollapsed(instanceId, false);
            },
          },
          {
            // Cmd/Ctrl+Up: close (collapse) an open bullet that has children.
            // Mirror of Mod+ArrowDown -- Up only ever closes; otherwise a no-op.
            hotkey: "Mod+ArrowUp",
            callback: () => {
              if (hasChildren && !instanceCollapsed)
                commands.onToggleCollapsed(instanceId, true);
            },
          },
          {
            // Cmd/Ctrl+.: zoom this node to become the temporary root.
            hotkey: "Mod+.",
            callback: () => commands.onZoom(node.id),
          },
        ]
      : EMPTY_KEYMAP,
    { target: textRef, enabled },
  );
}

// Whether the current selection spans exactly the whole bullet's text (the Cmd+A
// ladder uses this to tell rung 1 "select the text" from rung 2 "select the
// node"). A collapsed caret, a partial selection, or a selection that overflows
// this bullet is not "all selected". Compared by string rather than range
// boundary points: a native contentEditable Cmd+A selects at the editing-host
// level, so the range's commonAncestorContainer can be an ANCESTOR of the span
// (range-containment checks then wrongly fail). The selected text equalling the
// bullet's text is the reliable signal.
function isAllTextSelected(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const text = el.textContent ?? "";
  return text.length > 0 && sel.toString() === text;
}

// Caret at the very start of the bullet, measured by absolute offset so the
// test holds whether the line is one text node or split around chips.
function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  return getCaretOffset(el) === 0;
}

function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
  return getCaretOffset(el) === readSource(el).length;
}

function isCollapsedCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  return !!sel && sel.isCollapsed && isCaretAtStart(el);
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
