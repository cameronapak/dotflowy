import { memo, useEffect, useRef } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { Node } from "../data/schema";
import type { TreeIndex } from "../data/tree";
import { childrenOf } from "../data/tree";
import { useSlashMenu } from "./slash-menu";

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
}

export interface NodeCommands {
  onTextChange: (id: string, text: string) => void;
  onEnter: (id: string, caretAtEnd: boolean) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  onDeleteEmpty: (id: string) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
  // Set whether a bullet is a task (checkbox shown/hidden).
  onSetTask: (id: string, isTask: boolean) => void;
  onToggleCollapsed: (id: string, collapsed: boolean) => void;
  onMoveFocus: (id: string, direction: "up" | "down") => void;
  // Zoom the outline so this node becomes the temporary root.
  onZoom: (id: string) => void;
}

export const OutlineNode = memo(function OutlineNode({
  node,
  index,
  commands,
  registerRef,
  pivotId,
}: OutlineNodeProps) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const children = childrenOf(index, node.id);
  const hasChildren = children.length > 0;
  const isPivot = node.id === pivotId;

  // The "/" command menu for this bullet. Only the focused bullet ever has a
  // caret, so at most one menu is open across the whole outline.
  const slash = useSlashMenu({
    node,
    commands,
    getEl: () => textRef.current,
    onTextChange: (text) => commands.onTextChange(node.id, text),
  });

  // Keep the contentEditable in sync with stored text WITHOUT clobbering
  // the user's caret. We only write to the DOM when the stored text
  // differs from what's rendered, which is essentially never during
  // typing (the keystroke updates the store which echoes back equal).
  useEffect(() => {
    const el = textRef.current;
    if (el && el.textContent !== node.text) {
      el.textContent = node.text;
    }
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
        // Backspace on an empty bullet: delete it and focus the previous node.
        hotkey: "Backspace",
        callback: (e) => {
          const el = textRef.current;
          if (!el || el.textContent !== "" || !isCaretAtStart(el)) return;
          e.preventDefault();
          e.stopPropagation();
          commands.onDeleteEmpty(node.id);
        },
        options: { preventDefault: false, stopPropagation: false },
      },
      {
        // ArrowUp at the start of the line: move focus to the previous node.
        hotkey: "ArrowUp",
        callback: (e) => {
          const el = textRef.current;
          if (!el || !atLineStart(el)) return;
          e.preventDefault();
          e.stopPropagation();
          commands.onMoveFocus(node.id, "up");
        },
        options: { preventDefault: false, stopPropagation: false },
      },
      {
        // ArrowDown at the end of the line: move focus to the next node.
        hotkey: "ArrowDown",
        callback: (e) => {
          const el = textRef.current;
          if (!el || !atLineEnd(el)) return;
          e.preventDefault();
          e.stopPropagation();
          commands.onMoveFocus(node.id, "down");
        },
        options: { preventDefault: false, stopPropagation: false },
      },
    ],
    { target: textRef, enabled: !slash.isOpen },
  );

  return (
    <li className="outline-node" data-node-id={node.id}>
      <div className="outline-row">
        <button
          type="button"
          className="collapse-toggle"
          aria-label={node.collapsed ? "Expand" : "Collapse"}
          data-has-children={hasChildren}
          data-collapsed={node.collapsed}
          // Childless rows render no glyph but keep the gutter clickable-free.
          onClick={() =>
            hasChildren && commands.onToggleCollapsed(node.id, !node.collapsed)
          }
          tabIndex={-1}
        >
          {hasChildren &&
            (node.collapsed ? (
              <ChevronRight size={14} strokeWidth={2.5} />
            ) : (
              <ChevronDown size={14} strokeWidth={2.5} />
            ))}
        </button>
        <button
          type="button"
          className="bullet"
          aria-label="Zoom in"
          onClick={() => commands.onZoom(node.id)}
          title="Zoom in"
        >
          <span
            className="bullet-dot"
            data-completed={node.completed}
            data-has-children={hasChildren}
          />
        </button>
        {node.isTask && (
          <Checkbox
            className="checkbox"
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
            commands.onTextChange(node.id, e.currentTarget.textContent ?? "");
            slash.handleInput();
          }}
          onBlur={slash.close}
          // The "/" menu owns its own Arrow/Enter/Tab/Esc navigation while
          // open; the outline shortcuts above defer to it via `enabled`.
          onKeyDown={slash.handleKeyDown}
        />
        {slash.menu}
      </div>

      {!node.collapsed && hasChildren && (
        <ul className="outline-children">
          {children.map((child) => (
            <OutlineNode
              key={child.id}
              node={child}
              index={index}
              commands={commands}
              registerRef={registerRef}
              pivotId={pivotId}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0);
  return range.endOffset === el.textContent?.length;
}

function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  return sel.getRangeAt(0).endOffset === 0;
}

function atLineStart(el: HTMLElement): boolean {
  return isCaretAtStart(el);
}

function atLineEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  return sel.getRangeAt(0).endOffset === (el.textContent?.length ?? 0);
}
