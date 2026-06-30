import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react-dom";
import {
  ClipboardCopyIcon,
  CopyPlusIcon,
  CornerUpRightIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { getTreeIndex } from "../data/tree-store";
import { getViewIsHidden, getViewRootId } from "../data/view-state";
import { findVisibleNeighbor, lastVisibleDescendant } from "../data/visible-order";
import {
  indentManyNodes,
  outdentManyNodes,
  removeManyNodes,
} from "../data/mutations";
import { runStructural } from "../data/structural";
import { capture, drop } from "../data/history";
import { outlineToMarkdown } from "../data/markdown";
import {
  clearSelection,
  extendSelection,
  getSelectionRootIds,
  getSelectionState,
  isWholeViewSelected,
  refreshSelection,
  selectAllInView,
  useIsSelectionActive,
  useSelectionRootIds,
} from "../data/selection-state";
import { isProtected, selectionCommandSpecs } from "../plugins/registry";
import { isMirrorsEnabled } from "../data/flags";
import type { PluginContext } from "../plugins/types";
import { rejectRow } from "./flash-node";
import { placeCaretAtEnd } from "./caret-place";
import { openMoveDialog } from "./move-dialog-opener";
import { SlashMenuList, type MenuListItem } from "./slash-menu-list";

/**
 * Node multi-selection's runtime half (ADR 0018): the while-selected keyboard
 * (no caret is focused, so it's a window-level handler) and the actions menu.
 * The selection MODEL lives in `data/selection-state.ts`; this is the editor
 * side that needs DOM access -- the refs registry to land the caret on exit, and
 * the pending-focus ref to focus a neighbor after a delete.
 *
 * Caret and selection are mutually exclusive: entering selection blurs the
 * bullet (use-bullet-keymap), so while it's active focus sits on `<body>` and a
 * capture-phase window listener owns the keys. Leaving selection (Escape, a
 * plain arrow, a click, a menu action) drops the caret back onto a real bullet,
 * whose `onFocus` clears the selection.
 */

interface SelectionModeArgs {
  refs: Map<string, HTMLSpanElement | null>;
  /** The editor's post-render focus target (FocusPass consumes it). A delete
   *  sets it to the surviving neighbor. */
  pendingFocus: RefObject<string | null>;
}

export interface SelectionOps {
  copy: () => void;
  remove: () => void;
  move: () => void;
  mirror: () => void;
  indent: () => void;
  outdent: () => void;
  caretAbove: () => void;
  caretBelow: () => void;
  exitToCaret: () => void;
}

function makeSelectionOps({
  refs,
  pendingFocus,
}: SelectionModeArgs): SelectionOps {
  const rowOf = (id: string) => refs.get(id)?.closest(".outline-row") ?? null;

  const focusNode = (id: string) => {
    const el = refs.get(id);
    if (el) {
      el.focus();
      placeCaretAtEnd(el);
    }
  };

  // Copy the selected roots' subtrees as a markdown bullet list (reuses the
  // ADR 0017 serializer verbatim). Read-only, so the selection persists.
  const copy = () => {
    const md = outlineToMarkdown(getTreeIndex(), getSelectionRootIds());
    if (!md) return;
    navigator.clipboard
      .writeText(md)
      .then(() => toast.success("Copied as Markdown"))
      .catch(() => toast.error("Couldn't copy to clipboard"));
  };

  // Delete every selected root (and its subtree) in ONE atomic batch
  // (removeManyNodes inside runStructural -- ADR 0009), then focus the surviving
  // row above the block (else the row below, else the view root). Protected
  // nodes (the daily container) are skipped + shaken, mirroring the single-node
  // delete guard; if every selected node is protected, nothing is removed and
  // the selection stays.
  const remove = () => {
    const ids = getSelectionRootIds();
    if (ids.length === 0) return;
    const index = getTreeIndex();
    const protectedIds = ids.filter((id) => isProtected(id));
    const deletable = ids.filter((id) => !isProtected(id));
    if (protectedIds.length > 0) {
      for (const id of protectedIds) rejectRow(rowOf(id));
      toast.error(
        protectedIds.length === ids.length
          ? "These nodes are protected and can't be deleted."
          : "Some selected nodes are protected and were kept.",
      );
    }
    if (deletable.length === 0) return; // nothing removed; keep the selection
    const isHidden = getViewIsHidden();
    const rootId = getViewRootId();
    // Focus relative to the rows actually being DELETED, not the full selection:
    // a surviving protected node at the top/bottom edge must not be jumped over.
    // `above` = the row above the first deleted node (often that surviving
    // protected one); `below` = the row after the last deleted node's subtree.
    const firstDel = deletable[0]!;
    const lastDel = deletable[deletable.length - 1]!;
    const above = findVisibleNeighbor(index, rootId, firstDel, "up", isHidden);
    const bottom = lastVisibleDescendant(index, lastDel, isHidden);
    const below = findVisibleNeighbor(index, rootId, bottom, "down", isHidden);
    runStructural(() => {
      capture(getTreeIndex(), deletable[0]!);
      removeManyNodes(deletable);
    });
    pendingFocus.current = above ?? below ?? rootId;
    clearSelection();
  };

  // Open the destination picker for the whole run (the dialog moves them as one
  // atomic batch). The dialog now owns the ids, so leave selection mode.
  const move = () => {
    const ids = getSelectionRootIds();
    if (ids.length === 0) return;
    openMoveDialog([...ids]);
    clearSelection();
  };

  // Mirror the whole run: the same picker in mirror mode creates a live mirror
  // of each selected root under the destination (ADR 0022), as one batch. The
  // dialog owns the ids now, so leave selection mode (mirrors the Move action).
  const mirror = () => {
    const ids = getSelectionRootIds();
    if (ids.length === 0) return;
    openMoveDialog([...ids], "mirror");
    clearSelection();
  };

  // Tab: indent the whole run under the first root's previous sibling, as ONE
  // atomic batch (ADR 0009). The selection PERSISTS (the moved run stays
  // selected) -- refreshSelection re-derives its new parent so the next Tab /
  // Shift+arrow reads accurate state. A no-op (run is already a first child)
  // discards the redundant undo point.
  const indent = () => {
    const ids = getSelectionRootIds();
    if (ids.length === 0) return;
    runStructural(() => {
      capture(getTreeIndex(), ids[0]!);
      if (indentManyNodes(ids)) refreshSelection();
      else drop();
    });
  };

  // Shift+Tab: outdent the whole run one level (mirror of indent). A run sitting
  // directly under the zoom root must not escape it (would look like it vanished),
  // mirroring single-node onOutdent's guard; that's a no-op.
  const outdent = () => {
    const ids = getSelectionRootIds();
    if (ids.length === 0) return;
    const state = getSelectionState();
    if (!state || state.parentId === null || state.parentId === getViewRootId())
      return;
    runStructural(() => {
      capture(getTreeIndex(), ids[0]!);
      if (outdentManyNodes(ids)) refreshSelection();
      else drop();
    });
  };

  // Plain Up: drop the caret onto the visible row just ABOVE the top of the
  // selection (visual motion, even though selection is sibling-scoped).
  const caretAbove = () => {
    const state = getSelectionState();
    if (!state) return;
    const index = getTreeIndex();
    const top = state.rootIds[0]!;
    const target =
      findVisibleNeighbor(index, getViewRootId(), top, "up", getViewIsHidden()) ??
      top;
    clearSelection();
    focusNode(target);
  };

  // Plain Down: drop the caret onto the visible row just BELOW the bottom of the
  // selection -- the row after the last root's deepest-last visible descendant.
  const caretBelow = () => {
    const state = getSelectionState();
    if (!state) return;
    const index = getTreeIndex();
    const isHidden = getViewIsHidden();
    const lastRoot = state.rootIds[state.rootIds.length - 1]!;
    const bottom = lastVisibleDescendant(index, lastRoot, isHidden);
    const target =
      findVisibleNeighbor(index, getViewRootId(), bottom, "down", isHidden) ??
      bottom;
    clearSelection();
    focusNode(target);
  };

  // Escape: clear the selection and return the caret to the moving (focus) end.
  const exitToCaret = () => {
    const state = getSelectionState();
    if (!state) return;
    const id = state.focusId;
    clearSelection();
    focusNode(id);
  };

  return { copy, remove, move, mirror, indent, outdent, caretAbove, caretBelow, exitToCaret };
}

/**
 * Install the while-selected keyboard (only while a selection is active) and
 * expose the ops + the active flag. The window listeners read live selection
 * state, so the only effect dep is `active` (toggles the listeners) plus the
 * stable `ops`.
 */
export function useSelectionMode({
  refs,
  pendingFocus,
}: SelectionModeArgs): {
  active: boolean;
  ops: SelectionOps;
} {
  // refs is a stable useState Map and pendingFocus a stable ref -- so ops keeps
  // its identity and the listener effect below only re-subscribes when `active`
  // flips, never per render. (getCtx is only for the menu's plugin commands.)
  const ops = useMemo(
    () => makeSelectionOps({ refs, pendingFocus }),
    [refs, pendingFocus],
  );
  const active = useIsSelectionActive();

  // Clear any stale selection carried across an editor (re)mount -- the
  // singleton outlives the per-zoom remount, but a new view starts caret-first.
  useEffect(() => {
    clearSelection();
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        ops.exitToCaret();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        // Cmd+A rung 3: escalate to the whole view. Bounded -- once it already
        // covers the view, a further press does nothing.
        e.preventDefault();
        if (!isWholeViewSelected()) selectAllInView();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        ops.copy();
        return;
      }
      // Let other Cmd/Ctrl chords (undo, reload, ...) through untouched.
      if (mod) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        ops.remove();
        return;
      }
      if (e.shiftKey && e.key === "ArrowDown") {
        e.preventDefault();
        extendSelection("down");
        return;
      }
      if (e.shiftKey && e.key === "ArrowUp") {
        e.preventDefault();
        extendSelection("up");
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        ops.caretBelow();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        ops.caretAbove();
        return;
      }
      // Tab indents the whole run, Shift+Tab outdents it (ADR 0018) -- one atomic
      // batch each; the selection persists so you can keep nudging. preventDefault
      // either way so focus can't tab out of the selection.
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) ops.outdent();
        else ops.indent();
        return;
      }
      // A printable key is a NO-OP; the selection persists. Never replace-on-type
      // the way a text editor does, or a stray keypress would delete subtrees.
      if (e.key.length === 1 && !e.altKey) {
        e.preventDefault();
      }
    };
    // A mousedown anywhere leaves selection mode -- EXCEPT on the actions menu
    // (whose buttons run a command). A bullet click also focuses it, which
    // clears via onFocus; this covers clicks on empty space too.
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="listbox"]')) return;
      clearSelection();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [active, ops]);

  return { active, ops };
}

// --- the actions menu -------------------------------------------------------

type SelItem = MenuListItem & { run: () => void };

/**
 * The selection actions menu: auto-appears anchored to the **active (focus) edge**
 * of the selection -- the newest node a `Shift+arrow` just added -- and re-anchors
 * to it on every extension, so it tracks the node you're selecting instead of
 * sitting over the run's text (ADR 0018). Positioning is delegated to floating-ui
 * (the same engine Base UI uses): its preferred side is the OUTER edge of the run
 * (below when the run grows down, above when it grows up, below for a lone single
 * node) so it stays off the selected text, while `flip()` + `shift()` keep it
 * fully on screen at any viewport edge -- flipping below at the top boundary
 * rather than clipping off-screen. `autoUpdate` re-solves on scroll/resize too.
 * The focus row itself is kept on screen with a stock `scrollIntoView` (selection
 * extension never focuses a row, so nothing else scrolls it).
 *
 * Reuses `SlashMenuList`'s look (no second menu style). Lists the core
 * Copy + Move + Delete, plus every plugin command that opted into `runMany` and
 * applies to at least one selected node. Mouse-driven (the while-selected arrows
 * are taken for caret motion); the two most-reached ops, Copy and Delete, also
 * have direct keys.
 */
export function SelectionActionsMenu({
  ops,
  getCtx,
}: {
  ops: SelectionOps;
  getCtx: () => PluginContext;
}) {
  const active = useIsSelectionActive();
  const rootIds = useSelectionRootIds();
  const [hover, setHover] = useState(0);

  // The focus edge (newest selected node) and its outer side. The run is
  // anchor..focus in visible order, so focus is always an end: the LAST root when
  // the run grew down (menu below), otherwise the top (menu above). A lone
  // single-node run reads as "below". Read live -- the rootIds subscription
  // re-renders on every selection change, so this stays in sync.
  const state = active ? getSelectionState() : null;
  const focusId = state?.focusId;
  const side =
    focusId && focusId === rootIds[rootIds.length - 1] ? "bottom-start" : "top-start";

  const { refs, floatingStyles, update } = useFloating({
    placement: side,
    strategy: "fixed",
    // offset: gap from the row. flip: swap to the other side when this one would
    // clip (the on-screen guarantee at the top/bottom edge). shift: slide along
    // the edge to stay within an 8px viewport inset.
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // Point floating-ui at the focus row's LIVE element on every extension. Query
  // the DOM (not the refs registry): the bullet span's ref is an inline arrow
  // (fresh identity each commit), so the Map can lag a commit; the `data-node-id`
  // row is in the DOM by the layout phase.
  useLayoutEffect(() => {
    if (!active || !focusId) {
      refs.setReference(null);
      return;
    }
    const row = document.querySelector(
      `li[data-node-id="${focusId}"] > .outline-row`,
    );
    if (row instanceof HTMLElement) {
      // Keep the node you're selecting on screen -- selection extension never
      // focuses a row, so nothing else scrolls it. floating-ui then keeps the
      // MENU on screen relative to the row.
      row.scrollIntoView({ block: "nearest" });
      refs.setReference(row);
    } else {
      refs.setReference(null);
    }
    update();
    setHover(0);
  }, [active, focusId, rootIds, refs, update]);

  const items = active && rootIds.length ? buildItems(rootIds, ops, getCtx) : null;
  if (!active || !focusId || !items) return null;

  const onSelect = (i: number) => {
    const item = items[i];
    if (!item) return;
    item.run();
    // Copy is read-only and keeps the selection; everything else exits selection
    // mode (the core ops already clear; a plugin runMany doesn't, so clear here).
    if (item.id !== "sel-copy") clearSelection();
  };

  return createPortal(
    <SlashMenuList
      ref={refs.setFloating}
      style={floatingStyles}
      items={items}
      activeIndex={hover}
      onHover={setHover}
      onSelect={onSelect}
    />,
    document.body,
  );
}

function buildItems(
  rootIds: string[],
  ops: SelectionOps,
  getCtx: () => PluginContext,
): SelItem[] {
  const index = getTreeIndex();
  const core: SelItem[] = [
    {
      id: "sel-copy",
      label: "Copy as Markdown",
      description: "Copy the selected nodes",
      icon: ClipboardCopyIcon,
      run: ops.copy,
    },
    {
      id: "sel-move",
      label: "Move",
      description: "Move the selection under another node",
      icon: CornerUpRightIcon,
      run: ops.move,
    },
  ];
  // Mirror sits next to Move, but only when the feature flag is on (ADR 0022) --
  // a mirror-free build never offers it (matches the core `/mirror` slash gate).
  if (isMirrorsEnabled()) {
    core.push({
      id: "sel-mirror",
      label: "Mirror",
      description: "Show live copies under another node",
      icon: CopyPlusIcon,
      run: ops.mirror,
    });
  }
  // Plugin commands that opted in (To-do, Send to Today), kept only when they
  // apply to at least one selected node (To-do hides when all are already tasks).
  const pluginItems: SelItem[] = selectionCommandSpecs
    .filter((c) =>
      rootIds.some((id) => {
        const n = index.byId.get(id);
        return !!n && c.available(n);
      }),
    )
    .map((c) => ({
      id: `sel-${c.id}`,
      label: c.label,
      description: c.description,
      icon: c.icon,
      run: () => c.runMany!(rootIds, getCtx()),
    }));
  const del: SelItem = {
    id: "sel-delete",
    label: "Delete",
    description: "Delete the selected nodes",
    icon: Trash2Icon,
    run: ops.remove,
  };
  return [...core, ...pluginItems, del];
}
