// Structural markdown paste (ADR 0044): take the plan `markdown-import.ts`
// produced and land it. Reuse, not invention -- one history `capture`, one
// `runStructural` batch (so one Cmd+Z removes the whole paste, ADR 0009), the
// same protection guards every command funnel runs (ADR 0015), and the OPML
// import's sliced apply once the batch is big enough to freeze the main thread.
//
// This is CORE, deliberately: structural paste *creates nodes*, and every guard
// that makes node creation safe is core. It runs BEFORE the Seam I plugin chain,
// which is why a bare URL inside a pasted line stays plain text while a lone
// pasted URL still becomes a chip (ADR 0044: "a transfer preserves").

import { toast } from "sonner";
import { nodesCollection } from "../data/collection";
import { isMirrorsEnabled } from "../data/flags";
import { focusKeyFor } from "../data/focus-key";
import { capture, drop, RESTORE_SLICE_OPS } from "../data/history";
import {
  countForest,
  parseMarkdownForest,
  planMarkdownPaste,
  PASTE_MAX_LENGTH,
  PASTE_MAX_NODES,
  type MdPastePlacement,
  type MdPastePlan,
} from "../data/markdown-import";
import { runStructural, runStructuralSliced } from "../data/structural";
import { makeNode, now } from "../data/tree";
import { getTreeIndex } from "../data/tree-store";
import { getViewFilter, getViewIsHidden, getViewRootId } from "../data/view-state";
import { buildVisibleRows } from "../data/visible-order";
import { scrollRowIntoView } from "../data/virtual-nav";
import { guardProtected } from "./protection";
import { setRestoreProgress } from "./history-restore";

/** How the editor hands the caret back once the tree has landed. `offset` is a
 *  SOURCE offset inside the focused node's text (the seam where `tail` welded
 *  back on), consumed by `FocusPass` / the row's mount claim. */
export interface PasteFocusSink {
  setPendingFocus: (key: string, offset: number) => void;
  /** Re-decorate the still-focused anchor element and drop the caret in it, for
   *  the paste whose seam never left the bullet it started in. */
  placeCaretHere: (text: string, offset: number) => void;
}

export interface MarkdownPasteArgs {
  /** The clipboard's `text/plain`, already newline-normalized upstream. */
  source: string;
  /** `Mod+Shift+V`: one verbatim bullet per line, no grammar at all. */
  literal: boolean;
  /** The CONTENT node the caret is in (a mirror row resolves to its source). */
  anchorId: string;
  /** The row key the user was editing, for mirror-aware focus. */
  activeKey: string;
  /** A list bullet takes remaining roots as siblings; the zoomed title cannot. */
  placement: MdPastePlacement;
  /** Source text left of / right of the collapsed caret. */
  head: string;
  tail: string;
  /** The `.outline-row` to shake when a protection guard rejects. */
  rowEl: Element | null;
  focus: PasteFocusSink;
}

/**
 * Land a multi-line paste as a tree. Returns true when the paste was handled
 * (including a rejection -- nothing more should be inserted), false when there
 * was nothing structural to do and the caller should fall back to plain text.
 */
export function pasteMarkdownTree(args: MarkdownPasteArgs): boolean {
  const { source, literal, anchorId, activeKey, placement, head, tail, rowEl, focus } = args;

  // Guard the raw input before the line scan, the OPML byte-ceiling's shape.
  if (source.length > PASTE_MAX_LENGTH) {
    toast.error("That paste is too large.");
    return true;
  }

  const forest = parseMarkdownForest(source, { literal });
  if (forest.length === 0) return false; // an all-blank paste: nothing to land

  const count = countForest(forest);
  if (count > PASTE_MAX_NODES) {
    // Rejection is loud, because it is the ONLY disclosure surface a paste has:
    // there is no confirm step to carry a degradation report (ADR 0044).
    toast.error(
      `That paste is ${count.toLocaleString()} bullets; the limit is ${PASTE_MAX_NODES.toLocaleString()}. Nothing was pasted.`,
    );
    return true;
  }

  const index = getTreeIndex();
  const plan = planMarkdownPaste({
    index,
    anchorId,
    placement,
    forest,
    head,
    tail,
    newId: () => crypto.randomUUID(),
  });
  if (!plan) return false;

  // Protection (ADR 0015): pasting a forest UNDER the Daily container is fine;
  // blanking its canonical text, or converting it to a task, is not. Same
  // chokepoint every other command funnel uses -- a rejection shakes and toasts.
  const anchor = index.byId.get(anchorId);
  const wouldBlank = plan.anchor.text.trim() === "" && (anchor?.text.trim() ?? "") !== "";
  if (wouldBlank && guardProtected(anchorId, "blank", rowEl)) return true;
  if (plan.anchor.isTask && guardProtected(anchorId, "task", rowEl)) return true;

  const timestamp = now();
  const writeAnchor = () => {
    nodesCollection.update(anchorId, (draft) => {
      draft.text = plan.anchor.text;
      if (plan.anchor.isTask !== null) draft.isTask = plan.anchor.isTask;
      if (plan.anchor.completed !== null) draft.completed = plan.anchor.completed;
      draft.updatedAt = timestamp;
    });
  };
  const writeInsert = (i: number) => {
    const node = plan.inserts[i]!;
    nodesCollection.insert(
      makeNode({ ...node, createdAt: timestamp, updatedAt: timestamp }),
    );
  };
  const writeRepoints = () => {
    for (const r of plan.repoints) {
      nodesCollection.update(r.id, (draft) => {
        draft.prevSiblingId = r.prevSiblingId;
        draft.updatedAt = timestamp;
      });
    }
  };

  const opCount = 1 + plan.insertCount + plan.repoints.length;
  // ONE undo point BEFORE the batch: a single Cmd+Z removes the whole paste.
  capture(index, activeKey);

  if (opCount < RESTORE_SLICE_OPS) {
    // The keystroke-adjacent path. It must stay synchronous: no confirm step, no
    // modal, no await. `DELETE_CONFIRM_THRESHOLD` exists because deletion is
    // destructive; a paste is additive and one Cmd+Z away.
    runStructural(() => {
      writeAnchor();
      for (let i = 0; i < plan.inserts.length; i++) writeInsert(i);
      writeRepoints();
    });
    const seam = resolveSeam(plan, anchorId, count);
    if (seam.id === anchorId) focus.placeCaretHere(plan.anchor.text, seam.offset);
    else {
      // The seam row may not be mounted (a long paste in the windowed list), so
      // scroll it in and let it claim the pending focus on mount (ADR 0019).
      const key = focusKeyFor(seam.id, activeKey);
      focus.setPendingFocus(key, seam.offset);
      scrollRowIntoView(key);
    }
    return true;
  }

  // No focus hand-off on the sliced path: the modal owned focus, and by the time
  // the batch commits the tree-change effect window `FocusPass` consumes has
  // passed (`history-restore.tsx` drops the caret the same way).
  void runSliced(plan.insertCount, opCount, {
    writeAnchor,
    writeInsert,
    writeRepoints,
    count,
  });
  return true;
}

/**
 * Where the caret actually lands, once the tree is on screen.
 *
 * View transforms can hide what just landed and the paste must not fight them
 * (ADR 0044: a paste never mutates view state). So focus falls BACK: from the
 * seam (`tail`'s weld point) backward through the inserted nodes to the last
 * VISIBLE one, else the anchor. And when nothing inserted is visible the paste
 * changed nothing on screen -- the one silent outcome -- so it is disclosed,
 * loudly, because a toast is the only disclosure surface a paste has.
 */
function resolveSeam(
  plan: MdPastePlan,
  anchorId: string,
  count: number,
): { id: string; offset: number } {
  if (plan.focusId === anchorId) return { id: anchorId, offset: plan.focusOffset };

  const visible = new Set(
    buildVisibleRows(
      getTreeIndex(),
      getViewRootId(),
      getViewIsHidden(),
      getViewFilter(),
      isMirrorsEnabled(),
    ).map((r) => r.id),
  );
  if (visible.has(plan.focusId)) return { id: plan.focusId, offset: plan.focusOffset };

  for (let i = plan.inserts.length - 1; i >= 0; i--) {
    const node = plan.inserts[i]!;
    if (visible.has(node.id)) return { id: node.id, offset: node.text.length };
  }
  toast(`Pasted ${count.toLocaleString()} bullets — hidden by the current view.`);
  return { id: anchorId, offset: plan.anchor.text.length };
}

/** The big-paste apply: yielding slices behind the shared modal progress, so a
 *  5,000-bullet paste can't freeze the main thread mid-commit. The wire shape is
 *  unchanged -- still ONE batch POST, one DO `applyBatch`, one echo-hold. */
async function runSliced(
  insertCount: number,
  opCount: number,
  w: {
    writeAnchor: () => void;
    writeInsert: (i: number) => void;
    writeRepoints: () => void;
    count: number;
  },
): Promise<boolean> {
  let applied = 0;
  const slices: Array<() => void> = [
    () => {
      w.writeAnchor();
      applied++;
    },
  ];
  for (let i = 0; i < insertCount; i += RESTORE_SLICE_OPS) {
    const end = Math.min(i + RESTORE_SLICE_OPS, insertCount);
    slices.push(() => {
      for (let j = i; j < end; j++) w.writeInsert(j);
      applied += end - i;
    });
  }
  slices.push(() => {
    w.writeRepoints();
  });

  const show = () =>
    setRestoreProgress({
      kind: "restoring",
      label: "Pasting",
      total: opCount,
      applied,
    });
  show();
  // Let the modal paint before the first slice's burst (the OPML dialog's trick).
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await runStructuralSliced(slices, show);
    setRestoreProgress({ kind: "closed" });
    toast.success(`Pasted ${w.count.toLocaleString()} bullets.`);
    return true;
  } catch {
    // The transaction rolled back, so the outline already matches the captured
    // snapshot -- drop the redundant undo point (the OPML dialog's `drop()`).
    drop();
    setRestoreProgress({ kind: "closed" });
    toast.error("The paste could not be saved. Nothing was pasted.");
    return false;
  }
}
