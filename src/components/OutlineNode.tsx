import { memo, useEffect, useRef, type PointerEvent } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { Node } from "../data/schema";
import type { TreeIndex } from "../data/tree";
import { childrenOf } from "../data/tree";
import { useSlashMenu } from "./slash-menu";
import { decorate, getCaretOffset } from "./inline-code";

interface OutlineNodeProps {
  node: Node;
  index: TreeIndex;
  // Commands the editor knows how to run. Keeping them as a single
  // object avoids each node importing mutations + focus logic directly.
  commands: NodeCommands;
  // Refs registry so the editor can move focus between bullets.
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  // The node currently morphing across a zoom navigation, if any. When this
  // node is the pivot, its text claims the shared view-transition-name.
  pivotId: string | null;
  // True when an ancestor *within the current view* is completed, so this row
  // renders faded even if it isn't itself completed. Visual-only inheritance;
  // never written to data. Resets to false at each zoom root. See docs/adr/0002.
  ancestorCompleted: boolean;
  // Whether completed bullets are shown at all. When false, completed nodes and
  // their whole subtrees are filtered out of the render.
  showCompleted: boolean;
}

export interface NodeCommands {
  onTextChange: (id: string, text: string) => void;
  onEnter: (id: string, caretAtEnd: boolean) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  // Move a bullet (and its subtree) up/down among siblings; at the edge it
  // outdents one level in that direction. See docs/adr/0009.
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  // Delete a bullet and its entire subtree, then focus a neighbor.
  onDeleteNode: (id: string) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
  // Set whether a bullet is a task (checkbox shown/hidden).
  onSetTask: (id: string, isTask: boolean) => void;
  onToggleCollapsed: (id: string, collapsed: boolean) => void;
  // `x` is the caret's viewport x at the moment of the keypress, so the
  // landing node can drop the caret at the same column. Omitted when there's
  // no caret to preserve (e.g. the zoom title), which lands at the start.
  onMoveFocus: (id: string, direction: "up" | "down", x?: number) => void;
  // Zoom the outline so this node becomes the temporary root.
  onZoom: (id: string) => void;
  // Drag-to-reorder, hung off the bullet dot. pointerdown arms a drag; click
  // zooms only when no drag happened. See docs/adr/0010.
  onBulletPointerDown: (id: string, e: PointerEvent) => void;
  onBulletClick: (id: string) => void;
}

export const OutlineNode = memo(function OutlineNode({
  node,
  index,
  commands,
  registerRef,
  pivotId,
  ancestorCompleted,
  showCompleted,
}: OutlineNodeProps) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  // Inline `code` is decorated LIVE -- the contentEditable always holds
  // formatted HTML (mono chips), even while the caret is in the bullet. Each
  // keystroke re-tokenizes the line and rebuilds its DOM, so we save the caret
  // as an absolute character offset before the rebuild and restore it after
  // (see decorate()). Backticks stay visible inside the chip, which keeps the
  // source offset and the displayed offset identical -- no position mapping.
  //
  // Last text written to the DOM, so the sync effect skips redundant rebuilds
  // (and the caret-jitter they'd cause) on unrelated re-renders.
  const syncedRef = useRef<string | null>(null);
  // True between compositionstart/end (IME: accents, CJK). Rebuilding the DOM
  // mid-composition aborts the IME session, so we suspend decoration until it
  // ends, then decorate once with the committed text.
  const composingRef = useRef(false);
  // Hide completed subtrees when the toggle is off. Filtering here (where
  // children are listed) means a hidden completed node takes its whole subtree
  // with it for free.
  const children = childrenOf(index, node.id).filter(
    (c) => showCompleted || !c.completed,
  );
  const hasChildren = children.length > 0;
  const isPivot = node.id === pivotId;
  // Faded when this bullet is done, or sits anywhere under one that is.
  const faded = node.completed || ancestorCompleted;

  // The "/" command menu for this bullet. Only the focused bullet ever has a
  // caret, so at most one menu is open across the whole outline.
  const slash = useSlashMenu({
    node,
    commands,
    getEl: () => textRef.current,
    onTextChange: (text) => commands.onTextChange(node.id, text),
  });

  // Push stored text into the contentEditable as formatted HTML when it
  // changes from something OTHER than this bullet's own typing -- initial
  // mount, undo, a programmatic setText. The guard (syncedRef === node.text)
  // makes the common echo-after-keystroke a no-op: onInput already decorated
  // and recorded the text, so the store round-trip rebuilds nothing and the
  // caret never moves. We skip mid-composition; compositionend re-syncs.
  useEffect(() => {
    const el = textRef.current;
    if (!el || composingRef.current) return;
    if (syncedRef.current === node.text) return;
    // Preserve the caret only when this bullet is focused (e.g. undo while
    // editing); otherwise there's nothing to preserve.
    decorate(el, node.text, document.activeElement === el);
    syncedRef.current = node.text;
  });

  // Outline keyboard shortcuts, scoped to THIS bullet's contentEditable via
  // `target: textRef`. Scoping to the element is what lets single keys
  // (Enter/Tab/Backspace/Arrows) fire from a contentEditable -- the manager
  // only ignores input elements that aren't the registration's own target.
  //
  // While the "/" menu is open it owns Arrow/Enter/Tab/Esc, so we disable
  // these with `enabled: !slash.isOpen`. Disabled registrations bail before
  // any preventDefault/stopPropagation, so the menu's own onKeyDown is
  // untouched.
  //
  // Caret-conditional keys (Backspace/Arrows) opt out of the default
  // preventDefault/stopPropagation and call them manually only when they
  // actually act, so normal in-line editing and caret movement still work.
  useHotkeys(
    [
      {
        // Cmd/Ctrl+Enter: toggle completion on any bullet (task or plain).
        hotkey: "Mod+Enter",
        callback: () => commands.onToggleCompleted(node.id, !node.completed),
      },
      {
        // Enter: create a new empty sibling after this node.
        hotkey: "Enter",
        callback: () => {
          const el = textRef.current;
          commands.onEnter(node.id, el ? isCaretAtEnd(el) : true);
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
        // top edge it outdents to before its parent. Default options always
        // preventDefault, so macOS "extend selection to doc start" never
        // fires inside the outline. See ADR 0009.
        hotkey: "Mod+Shift+ArrowUp",
        callback: () => commands.onMoveUp(node.id),
      },
      {
        // Cmd/Ctrl+Shift+Down: move down; at the bottom edge it outdents to
        // after its parent. Mirror of Mod+Shift+ArrowUp.
        hotkey: "Mod+Shift+ArrowDown",
        callback: () => commands.onMoveDown(node.id),
      },
      {
        // Backspace on an empty bullet: delete it and focus the previous node.
        hotkey: "Backspace",
        callback: (e) => {
          const el = textRef.current;
          if (!el || el.textContent !== "" || !isCaretAtStart(el)) return;
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
    { target: textRef, enabled: !slash.isOpen },
  );

  return (
    <li className="outline-node" data-node-id={node.id}>
      <div className="outline-row" data-faded={faded}>
        <button
          type="button"
          className="collapse-toggle touch-hitbox"
          aria-label={node.collapsed ? "Expand" : "Collapse"}
          data-has-children={hasChildren}
          data-collapsed={node.collapsed}
          // Childless rows render no glyph but keep the gutter clickable-free.
          onClick={() =>
            hasChildren && commands.onToggleCollapsed(node.id, !node.collapsed)
          }
          tabIndex={-1}
        >
          {hasChildren && <ChevronRight size={14} strokeWidth={2.5} />}
        </button>
        <button
          type="button"
          className="bullet touch-hitbox"
          aria-label="Zoom in"
          onPointerDown={(e) => commands.onBulletPointerDown(node.id, e)}
          onClick={() => commands.onBulletClick(node.id)}
          title="Zoom in"
        >
          <span
            className="bullet-dot"
            data-completed={node.completed}
            data-has-children={hasChildren}
            data-collapsed={node.collapsed}
          />
        </button>
        {node.isTask && (
          <Checkbox
            className="checkbox border-foreground touch-hitbox"
            checked={node.completed}
            onCheckedChange={(checked) =>
              commands.onToggleCompleted(node.id, checked)
            }
          />
        )}
        <span
          ref={(el) => {
            textRef.current = el;
            registerRef(node.id, el);
          }}
          className={`node-text${isPivot ? " vt-morph" : ""}`}
          style={isPivot ? { viewTransitionName: "zoom-target" } : undefined}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          data-completed={node.completed}
          onInput={(e) => {
            const el = e.currentTarget;
            const text = el.textContent ?? "";
            commands.onTextChange(node.id, text);
            slash.handleInput();
            // Re-decorate live, preserving the caret. Suspended during IME
            // composition; compositionend handles that case.
            if (!composingRef.current) {
              decorate(el, text, true);
              syncedRef.current = text;
            }
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            const el = e.currentTarget;
            const text = el.textContent ?? "";
            commands.onTextChange(node.id, text);
            decorate(el, text, true);
            syncedRef.current = text;
          }}
          onBlur={slash.close}
          // The "/" menu owns its own Arrow/Enter/Tab/Esc navigation while
          // open; the outline shortcuts above defer to it via `enabled`.
          onKeyDown={slash.handleKeyDown}
        />
        {slash.menu}
      </div>

      {hasChildren && (
        // Children stay mounted while collapsed so the reveal/hide can animate
        // (the grid-rows trick needs both states present). The wrapper clamps
        // height to 0 when collapsed; the editor's visible-order walk skips
        // collapsed subtrees independently, so hidden rows are inert.
        <div className="outline-children-wrap" data-collapsed={node.collapsed}>
          <ul className="outline-children" aria-hidden={node.collapsed}>
            {children.map((child) => (
              <OutlineNode
                key={child.id}
                node={child}
                index={index}
                commands={commands}
                registerRef={registerRef}
                pivotId={pivotId}
                ancestorCompleted={faded}
                showCompleted={showCompleted}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
});

// Caret at the very end / start of the bullet, measured by absolute offset so
// the test holds whether the line is one text node or split around chips.
function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  return getCaretOffset(el) === (el.textContent?.length ?? 0);
}

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
