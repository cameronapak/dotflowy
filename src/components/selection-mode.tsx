import { Menu } from "@base-ui/react/menu";
import {
  ClipboardCopyIcon,
  CopyPlusIcon,
  CornerUpRightIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";

import type { CommandSpec, PluginContext } from "../plugins/types";
import type { MenuListItem } from "./slash-menu-list";

import {
  lockCommand,
  paragraphCommand,
  unlockCommand,
} from "../data/core-commands";
import { isMirrorsEnabled } from "../data/flags";
import { capture } from "../data/history";
import { outlineToMarkdown } from "../data/markdown";
import {
  indentManyNodes,
  outdentManyNodes,
  removeManyNodes,
} from "../data/mutations";
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
import { runStructural } from "../data/structural";
import {
  countSubtreeNodes,
  orphanedMirrorsBy,
  subtreeContainsLocked,
} from "../data/tree";
import { getTreeIndex } from "../data/tree-store";
import {
  getViewFilter,
  getViewIsHidden,
  getViewRootId,
} from "../data/view-state";
import { scrollRowIntoView } from "../data/virtual-nav";
import {
  buildVisibleRows,
  findVisibleNeighbor,
  instanceIdForKey,
  lastVisibleDescendant,
  parentKeyOf,
  rowKeyFor,
} from "../data/visible-order";
import { isProtected, usePluginChrome } from "../plugins/registry";
import { placeCaretAtEnd } from "./caret-place";
import {
  DELETE_CONFIRM_THRESHOLD,
  openDeleteConfirm,
} from "./delete-confirm-opener";
import { rejectRow } from "./flash-node";
import { openMoveDialog } from "./move-dialog-opener";

/**
 * Node multi-selection's runtime half (ADR 0018): the while-selected keyboard
 * (no caret is focused, so it's a window-level handler) and the actions menu.
 * The selection MODEL lives in `data/selection-state.ts`; this is the editor
 * side that needs DOM access -- the refs registry to land the caret on exit, and
 * the pending-focus ref to focus a neighbor after a delete.
 *
 * Caret and selection are mutually exclusive: entering selection blurs the
 * bullet (use-bullet-keymap), then the actions menu takes focus. A capture-phase
 * window listener owns bulk shortcuts; the menu owns its navigation. Leaving
 * selection (Escape, a click, a menu action) returns to a real bullet,
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
    } else {
      // Selection survives window eviction. Let the row claim focus after its
      // text is seeded on remount, using the same address as the refs registry.
      pendingFocus.current = id;
      if (!scrollRowIntoView(id)) pendingFocus.current = null;
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
    if (subtreeContainsLocked(index, ids)) {
      for (const id of ids) rejectRow(rowOf(id));
      toast.error("Unlock the protected subtree before deleting it.", {
        id: "node-locked-delete",
      });
      return;
    }
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
    // Deleting a SOURCE orphans its live mirrors (Stage 3 promotes; v1 blocks).
    // Check the whole deletable set at once, so selecting a source AND its
    // mirror together still deletes cleanly (both leave, nothing is orphaned). If
    // anything would be stranded, keep the selection and explain. Flag-gated:
    // off-flag a mirrorOf node is just a normal node, so this never fires.
    if (isMirrorsEnabled() && orphanedMirrorsBy(index, deletable).length > 0) {
      for (const id of deletable) rejectRow(rowOf(id));
      toast.error(
        "A selected node is mirrored elsewhere -- delete its mirrors first.",
        { id: "mirror-source-delete" },
      );
      return;
    }
    // Big-subtree gate: a threshold-plus selection asks first, then runs as
    // the dialog's sliced progress flow (capture + plan + one sliced batch
    // happen there). The dialog owns the ids now, so leave selection mode —
    // the Move/Mirror precedent.
    const count = countSubtreeNodes(index, deletable);
    if (count >= DELETE_CONFIRM_THRESHOLD) {
      openDeleteConfirm({
        rootIds: [...deletable],
        count,
        captureKey: deletable[0]!,
      });
      clearSelection();
      return;
    }
    const isHidden = getViewIsHidden();
    const rootId = getViewRootId();
    const filter = getViewFilter();
    // Focus relative to the rows actually being DELETED, not the full selection:
    // a surviving protected node at the top/bottom edge must not be jumped over.
    // `above` = the row above the first deleted node (often that surviving
    // protected one); `below` = the row after the last deleted node's subtree.
    const prefix = parentKeyOf(getSelectionState()!.anchorId);
    const firstDel = rowKeyFor(prefix, deletable[0]!);
    const lastDel = rowKeyFor(prefix, deletable[deletable.length - 1]!);
    const mirrorsOn = isMirrorsEnabled();
    const above = findVisibleNeighbor(
      index,
      rootId,
      firstDel,
      "up",
      isHidden,
      filter,
      mirrorsOn,
    );
    const rows = buildVisibleRows(index, rootId, isHidden, filter, mirrorsOn);
    const bottom = lastVisibleDescendant(rows, lastDel);
    const bottomIndex = rows.findIndex((row) => row.key === bottom);
    const below = bottomIndex === -1 ? null : rows[bottomIndex + 1]?.key;
    runStructural(() => {
      capture(getTreeIndex(), deletable[0]!, null, { label: "delete" });
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
      const drop = capture(getTreeIndex(), ids[0]!, null, { label: "indent" });
      if (indentManyNodes(ids, isMirrorsEnabled())) refreshSelection();
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
      const drop = capture(getTreeIndex(), ids[0]!, null, { label: "outdent" });
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
    const top = rowKeyFor(parentKeyOf(state.anchorId), state.rootIds[0]!);
    const target =
      findVisibleNeighbor(
        index,
        getViewRootId(),
        top,
        "up",
        getViewIsHidden(),
        getViewFilter(),
        isMirrorsEnabled(),
      ) ?? top;
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
    const filter = getViewFilter();
    const lastRoot = rowKeyFor(
      parentKeyOf(state.anchorId),
      state.rootIds[state.rootIds.length - 1]!,
    );
    const rows = buildVisibleRows(
      index,
      getViewRootId(),
      isHidden,
      filter,
      isMirrorsEnabled(),
    );
    const bottom = lastVisibleDescendant(rows, lastRoot);
    const bottomIndex = rows.findIndex((row) => row.key === bottom);
    const target =
      (bottomIndex === -1 ? null : rows[bottomIndex + 1]?.key) ?? bottom;
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

  return {
    copy,
    remove,
    move,
    mirror,
    indent,
    outdent,
    caretAbove,
    caretBelow,
    exitToCaret,
  };
}

/**
 * Install the while-selected keyboard (only while a selection is active) and
 * expose the ops + the active flag. The window listeners read live selection
 * state, so the only effect dep is `active` (toggles the listeners) plus the
 * stable `ops`.
 */
export function useSelectionMode({ refs, pendingFocus }: SelectionModeArgs) {
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
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      const inMenu = !!target?.closest("[data-selection-menu]");
      // IME navigation/confirmation must not run either a bulk command or a
      // menu action. keyCode 229 covers Safari's composition-end keydown.
      if (e.isComposing || e.keyCode === 229) {
        if (inMenu) e.stopPropagation();
        return;
      }
      // Another control owns its keys, even while the selected slab remains.
      if (!inMenu && target !== document.body) return;
      const mod = e.metaKey || e.ctrlKey;
      const selectionKey =
        e.key === "Escape" ||
        (mod && ["a", "c"].includes(e.key.toLowerCase())) ||
        (!mod &&
          (e.key === "Backspace" ||
            e.key === "Delete" ||
            e.key === "Tab" ||
            (e.shiftKey && ["ArrowDown", "ArrowUp"].includes(e.key))));
      if (inMenu && !selectionKey) return;
      // These keys belong to selection, not the menu's roving focus/typeahead.
      if (selectionKey) e.stopPropagation();
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
      // SAFETY: a window mousedown target is a DOM element
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-selection-menu]")) return;
      // Keep the selected slab alive while its bullet arms pointer drag. A
      // successful external drop clears it; pointer cancel and failed drops do
      // not. A plain dot click zooms and the new editor mount clears it.
      if (
        target?.closest<HTMLElement>(".bullet")?.closest("li[data-selected]")
      ) {
        // Pointerdown already armed the drag. Keep menu focus so a cancelled
        // gesture cannot strand selection shortcuts on the bullet button.
        e.preventDefault();
        return;
      }
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
 * sitting over the run's text (ADR 0018). Base UI positions it using floating-ui:
 * its preferred side is the OUTER edge of the run
 * (below when the run grows down, above when it grows up, below for a lone single
 * node), with collision handling at viewport edges and updates on scroll/resize.
 * The focus row itself is kept on screen with a stock `scrollIntoView` (selection
 * extension never focuses a row, so nothing else scrolls it).
 *
 * Keeps the slash menu's look, with Base UI owning menu focus, navigation,
 * typeahead and activation. Bulk shortcuts remain with useSelectionMode.
 */
export function SelectionActionsMenu({
  ops,
  getCtx,
}: {
  ops: SelectionOps;
  getCtx: () => PluginContext;
}) {
  const { selectionCommandSpecs } = usePluginChrome();
  const active = useIsSelectionActive();
  const rootIds = useSelectionRootIds();
  const firstItemRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<{
    element: HTMLElement;
    side: "bottom" | "top";
  } | null>(null);

  // Point floating-ui at the focus row's LIVE element on every extension. Query
  // the DOM (not the refs registry): the bullet span's ref is an inline arrow
  // (fresh identity each commit), so the Map can lag a commit; the `data-history-key`
  // row is in the DOM by the layout phase. Read the live focus end here, not in
  // render where the compiler can memoize the imperative getter across changes.
  useLayoutEffect(() => {
    const focusId = getSelectionState()?.focusId;
    if (!active || !focusId) {
      setAnchor(null);
      return;
    }
    const row = document
      .querySelector(`[data-history-key="${CSS.escape(focusId)}"]`)
      ?.closest(".outline-row");
    if (row instanceof HTMLElement) {
      // Keep the node you're selecting on screen -- selection extension never
      // focuses a row, so nothing else scrolls it. floating-ui then keeps the
      // MENU on screen relative to the row.
      row.scrollIntoView({ block: "nearest" });
      setAnchor({
        element: row,
        side:
          instanceIdForKey(focusId) === rootIds[rootIds.length - 1]
            ? "bottom"
            : "top",
      });
    } else {
      setAnchor(null);
    }
  }, [active, rootIds]);

  const items =
    active && rootIds.length
      ? buildItems(rootIds, ops, getCtx, selectionCommandSpecs)
      : null;
  if (!active || !items) return null;

  const onSelect = (i: number) => {
    const item = items[i];
    if (!item) return;
    item.run();
    // Copy is read-only and keeps the selection; everything else exits selection
    // mode (the core ops already clear; a plugin runMany doesn't, so clear here).
    if (item.id !== "sel-copy") clearSelection();
  };

  return (
    // Selection owns dismissal, including the selected-dot drag exception.
    <Menu.Root
      open={!!anchor}
      modal={false}
      onOpenChangeComplete={(open) => {
        if (open) firstItemRef.current?.focus({ preventScroll: true });
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          anchor={anchor?.element}
          side={anchor?.side}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          positionMethod="fixed"
          className="z-50"
        >
          <Menu.Popup
            data-selection-menu
            aria-label="Selection actions"
            aria-description="Shift+Up or Shift+Down extends the selection. Tab or Shift+Tab indents or outdents. Escape returns to editing."
            finalFocus={false}
            className="w-64 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none"
          >
            <Menu.Group className="max-h-72 scroll-fade overflow-y-auto p-1">
              {items.map((item, i) => {
                const Icon = item.icon;
                return (
                  <Menu.Item
                    key={item.id}
                    ref={i === 0 ? firstItemRef : undefined}
                    label={item.label}
                    closeOnClick={false}
                    onClick={() => onSelect(i)}
                    className="flex w-full scroll-my-10 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <Icon className="size-4 shrink-0 opacity-70" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{item.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </Menu.Item>
                );
              })}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function buildItems(
  rootIds: string[],
  ops: SelectionOps,
  getCtx: () => PluginContext,
  selectionCommandSpecs: CommandSpec[],
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
  // Commands that opted in via `runMany` -- the plugins' (To-do, Send to Today)
  // plus core's `/paragraph` (ADR 0045) -- kept only when they apply to at least
  // one selected node (To-do hides when all are already tasks).
  const pluginItems: SelItem[] = [
    ...selectionCommandSpecs,
    paragraphCommand,
    lockCommand,
    unlockCommand,
  ]
    .filter((c) =>
      rootIds.some((id) => {
        const n = index.byId.get(id);
        return !!n && c.available(n, getCtx());
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
