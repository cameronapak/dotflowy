import { memo, useEffect, useRef, type PointerEvent } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { Node } from "../data/schema";
import { collectAllTags, type TagFilter } from "../data/tags";
import {
  getTreeIndex,
  useNode,
  useVisibleChildIds,
} from "../data/tree-store";
import { useSlashMenu } from "./slash-menu";
import { useTagMenu } from "./tag-menu";
import { decorate, getCaretOffset } from "./inline-code";

interface OutlineNodeProps {
  // The node id. The node itself and its visible children are read reactively
  // from the shared tree store (useNode / useVisibleChildIds), NOT threaded as
  // props -- that's what lets a keystroke re-render only the bullet that
  // changed instead of the whole tree. See ADR 0014.
  nodeId: string;
  // Commands the editor knows how to run. Keeping them as a single
  // object avoids each node importing mutations + focus logic directly.
  // Must be referentially stable, or every node re-renders on every keystroke.
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
  // Active tag filter, or null when none. When set, this node renders only if
  // it's in `visibleIds`; it's a match (normal styling) when in `matchIds`,
  // otherwise dimmed ancestor context. Filtering is render-time, so `collapsed`
  // is ignored -- matches inside collapsed subtrees are revealed. See ADR 0015.
  filter: TagFilter | null;
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
  // Open the `/move` destination picker for this bullet.
  onRequestMove: (id: string) => void;
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

/**
 * Thin reactive wrapper: reads this node from the shared store and renders the
 * body only when it exists. Memoized so a parent re-render skips it when its
 * (stable) props are unchanged; its own `useNode` subscription still re-renders
 * it when THIS node's data changes. The early return lives here -- before any
 * other hooks -- so the rules of hooks hold while still letting a deleted node
 * (id present in a parent's stale snapshot) render nothing. See ADR 0014.
 */
export const OutlineNode = memo(function OutlineNode({
  nodeId,
  ...rest
}: OutlineNodeProps) {
  const node = useNode(nodeId);
  if (!node) return null;
  return <OutlineNodeBody node={node} {...rest} />;
});

function OutlineNodeBody({
  node,
  commands,
  registerRef,
  pivotId,
  ancestorCompleted,
  showCompleted,
  filter,
}: Omit<OutlineNodeProps, "nodeId"> & { node: Node }) {
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
  // Visible child ids, read reactively from the store. The array keeps its
  // identity until the child set/order changes, so typing in a child doesn't
  // re-render this parent; a completion toggle that flips visibility does. A
  // hidden completed node takes its whole subtree with it for free.
  const childIds = useVisibleChildIds(node.id, showCompleted);
  // While filtering, only children on a path to a match stay visible, and the
  // collapse state is ignored so matches inside a closed subtree are revealed.
  // Filtering never mutates `collapsed` -- clearing the filter restores the
  // exact prior view (ADR 0015).
  const visibleChildIds = filter
    ? childIds.filter((id) => filter.visibleIds.has(id))
    : childIds;
  const hasChildren = visibleChildIds.length > 0;
  const effectiveCollapsed = filter ? false : node.collapsed;
  // Dimmed when this node is only here as ancestor context for a match below it.
  const isContext = filter ? !filter.matchIds.has(node.id) : false;
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

  // Tag autocomplete: typing "#" offers existing tags (read live from the
  // shared index) to complete. Coexists with the slash menu -- different
  // trigger chars, at most one open at a time. See ADR 0015.
  const tagMenu = useTagMenu({
    getEl: () => textRef.current,
    getAllTags: () => collectAllTags(getTreeIndex()),
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
        // Shift+Enter: same as Enter -- create a sibling, never insert a
        // literal newline. Captured explicitly so the contentEditable's
        // default line break can't fire; bullets are single-line.
        hotkey: "Shift+Enter",
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
    { target: textRef, enabled: !slash.isOpen && !tagMenu.isOpen },
  );

  return (
    <li className="outline-node" data-node-id={node.id}>
      <div className="outline-row" data-faded={faded} data-context={isContext}>
        <button
          type="button"
          className="collapse-toggle touch-hitbox"
          aria-label={effectiveCollapsed ? "Expand" : "Collapse"}
          data-has-children={hasChildren}
          data-collapsed={effectiveCollapsed}
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
            data-collapsed={effectiveCollapsed}
          />
        </button>
        {node.isTask && (
          <Checkbox
            className="checkbox touch-hitbox"
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
          spellCheck={false}
          role="textbox"
          data-completed={node.completed}
          onInput={(e) => {
            const el = e.currentTarget;
            const text = el.textContent ?? "";
            // Markdown-style task autoformat: typing "[]" or "[ ]" at the very
            // start of a plain bullet turns it into a task and strips the
            // marker. Mirrors the Backspace-on-the-checkbox demotion below.
            if (!node.isTask && !composingRef.current) {
              const marker = text.match(/^\[ ?\] ?/);
              if (marker) {
                const stripped = text.slice(marker[0].length);
                commands.onSetTask(node.id, true);
                commands.onTextChange(node.id, stripped);
                decorate(el, stripped, false);
                syncedRef.current = stripped;
                // Caret to the start -- the marker we stripped sat there.
                const sel = window.getSelection();
                if (sel) {
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  range.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
                return;
              }
            }
            commands.onTextChange(node.id, text);
            slash.handleInput();
            tagMenu.handleInput();
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
          onBlur={() => {
            slash.close();
            tagMenu.close();
          }}
          // The "/" and "#" menus own Arrow/Enter/Tab/Esc while open; the
          // outline shortcuts above defer via `enabled`. The tag menu gets first
          // crack (it's the more specific trigger), then the slash menu.
          onKeyDown={(e) => {
            if (tagMenu.handleKeyDown(e)) return;
            slash.handleKeyDown(e);
          }}
        />
        {slash.menu}
        {tagMenu.menu}
      </div>

      {hasChildren && (
        // Children stay mounted while collapsed so the reveal/hide can animate
        // (the grid-rows trick needs both states present). The wrapper clamps
        // height to 0 when collapsed; the editor's visible-order walk skips
        // collapsed subtrees independently, so hidden rows are inert.
        <div
          className="outline-children-wrap"
          data-collapsed={effectiveCollapsed}
        >
          <ul className="outline-children" aria-hidden={effectiveCollapsed}>
            {visibleChildIds.map((childId) => (
              <OutlineNode
                key={childId}
                nodeId={childId}
                commands={commands}
                registerRef={registerRef}
                pivotId={pivotId}
                ancestorCompleted={faded}
                showCompleted={showCompleted}
                filter={filter}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

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
