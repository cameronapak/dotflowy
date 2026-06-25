import { useMemo, type RefObject } from "react";
import { childrenOf, type Node, type TreeIndex } from "../../data/tree";
import { findVisibleNeighbor } from "../../data/visible-tree-walk";
import {
  indent,
  insertChildAtStart,
  insertSibling,
  moveDown,
  moveNode,
  moveUp,
  outdent,
  removeNode,
  setIsTask,
  setText,
  toggleCollapsed,
  toggleCompleted,
} from "../../data/mutations";
import { capture, drop } from "../../data/history";
import { isProtected } from "../../plugins/registry";
import type { NodeCommands } from "../node-commands";
import type { useDragReorder } from "../use-drag-reorder";
import { openMoveDialog } from "../move-dialog-opener";
import { placeCaretAtColumn, placeCaretAtStart } from "./caret";

interface NodeCommandsArgs {
  focusIndex: RefObject<TreeIndex>;
  rootIdRef: RefObject<string | null>;
  isHiddenRef: RefObject<(node: Node) => boolean>;
  refs: RefObject<Map<string, HTMLSpanElement | null>>;
  pendingFocus: RefObject<string | null>;
  pendingFocusAtStart: RefObject<boolean>;
  pendingFlash: RefObject<string | null>;
  navigateZoom: (toRootId: string | null, pivot: string) => void;
  startDrag: ReturnType<typeof useDragReorder>["startDrag"];
  consumeClick: ReturnType<typeof useDragReorder>["consumeClick"];
}

/**
 * The per-bullet command set, handed to every OutlineNode. Stable identity
 * (a prop on every memoized node) because every live value it needs is read
 * through a ref or is itself stable. See ADR 0014.
 */
export function useNodeCommands({
  focusIndex,
  rootIdRef,
  isHiddenRef,
  refs,
  pendingFocus,
  pendingFocusAtStart,
  pendingFlash,
  navigateZoom,
  startDrag,
  consumeClick,
}: NodeCommandsArgs): NodeCommands {
  return useMemo<NodeCommands>(
    () => ({
      onTextChange: (id, text) => {
        // Coalesce a run of keystrokes on one bullet into a single undo step,
        // capturing the pre-typing state on the first keystroke of the run.
        capture(focusIndex.current, id, `text:${id}`);
        setText(id, text);
      },

      onEnter: (id, caretOffset) => {
        const node = focusIndex.current.byId.get(id);
        if (!node) return;
        capture(focusIndex.current, id);
        const offset = Math.max(0, Math.min(caretOffset, node.text.length));
        const before = node.text.slice(0, offset);
        const after = node.text.slice(offset);
        const caretAtEnd = after.length === 0;
        // Pressing Enter at the end of an open (expanded, has-children) bullet
        // adds a child at the top of its list rather than a sibling -- you're
        // diving into the thing you just finished naming. Anywhere else keeps
        // the plain new-sibling.
        const isOpen =
          !node.collapsed && childrenOf(focusIndex.current, id).length > 0;
        if (caretAtEnd && isOpen) {
          pendingFocus.current = insertChildAtStart(
            focusIndex.current,
            id,
            node.isTask,
          );
          return;
        }
        // Split at the caret: text left of it stays on this node, text to its
        // right seeds the new sibling. (Caret at the end is just `after === ""`.)
        const newId = insertSibling(
          focusIndex.current,
          node.parentId,
          id,
          node.isTask,
          after,
        );
        if (!caretAtEnd) {
          setText(id, before);
          // Caret sits before the moved text, where the split happened.
          pendingFocusAtStart.current = true;
        }
        pendingFocus.current = newId;
      },

      onIndent: (id) => {
        // Moving the node reparents it into a different <ul>, which remounts
        // its contentEditable and drops focus. Re-focus it after the render.
        capture(focusIndex.current, id);
        if (indent(focusIndex.current, id)) {
          pendingFocus.current = id;
          pendingFlash.current = id;
        } else drop(); // no move happened; discard the redundant undo point
      },

      onOutdent: (id) => {
        // Don't let a direct child of the zoom root outdent past it; that
        // would move it out of the visible subtree and look like it vanished.
        const node = focusIndex.current.byId.get(id);
        if (node && node.parentId === rootIdRef.current) return;
        // Same remount-drops-focus issue as indent; re-focus on a real move.
        capture(focusIndex.current, id);
        if (outdent(focusIndex.current, id)) {
          pendingFocus.current = id;
          pendingFlash.current = id;
        } else drop();
      },

      onMoveUp: (id) => {
        // Reorder/outdent remounts the contentEditable; re-focus on a real move.
        capture(focusIndex.current, id);
        const moved = moveUp(focusIndex.current, id, {
          isVisible: (n) => !isHiddenRef.current(n),
          rootId: rootIdRef.current,
        });
        if (moved) {
          pendingFocus.current = id;
          pendingFlash.current = id;
        } else drop();
      },

      onMoveDown: (id) => {
        capture(focusIndex.current, id);
        const moved = moveDown(focusIndex.current, id, {
          isVisible: (n) => !isHiddenRef.current(n),
          rootId: rootIdRef.current,
        });
        if (moved) {
          pendingFocus.current = id;
          pendingFlash.current = id;
        } else drop();
      },

      onDeleteNode: (id) => {
        // A plugin can protect a node from deletion (the daily container). The
        // core no-ops here -- the single funnel every delete path flows through.
        if (isProtected(id)) return;
        capture(focusIndex.current, id);
        const focusId = removeNode(focusIndex.current, id);
        if (focusId) pendingFocus.current = focusId;
        else drop(); // node didn't exist; nothing was deleted
      },

      onToggleCompleted: (id, completed) => {
        capture(focusIndex.current, id);
        toggleCompleted(id, completed);
      },

      onSetTask: (id, isTask) => {
        capture(focusIndex.current, id);
        setIsTask(id, isTask);
      },

      // Open the move picker; the dialog runs the mutation + navigation itself.
      onRequestMove: (id) => openMoveDialog(id),

      onToggleCollapsed: (id, collapsed) => {
        capture(focusIndex.current, id);
        toggleCollapsed(id, collapsed);
      },

      onMoveFocus: (id, direction, x) => {
        const target = findVisibleNeighbor(
          focusIndex.current,
          rootIdRef.current,
          id,
          direction,
          isHiddenRef.current,
        );
        if (target) {
          const el = refs.current.get(target);
          if (el) {
            el.focus();
            if (x != null) placeCaretAtColumn(el, direction, x);
            else placeCaretAtStart(el);
          }
        }
      },

      // Zooming in: the clicked node is the pivot (list item -> title).
      onZoom: (id) => navigateZoom(id, id),

      onBulletPointerDown: (id, e) => startDrag(id, e),

      // The dot's click fires right after pointerup. Suppress the zoom when that
      // press was actually a drag; otherwise zoom as before.
      onBulletClick: (id) => {
        if (consumeClick()) return;
        navigateZoom(id, id);
      },
    }),
    // commands MUST keep stable identity (a prop on every memoized OutlineNode,
    // ADR 0014). Every live value it touches is read through a ref at call time
    // (focusIndex/refs/pendingFocus/...), so the only real deps are the three
    // stable callbacks; the flagged ref.current captures can't be listed and
    // would defeat the pattern.
    // eslint-disable-next-line react-doctor/exhaustive-deps
    [navigateZoom, startDrag, consumeClick],
  );
}
