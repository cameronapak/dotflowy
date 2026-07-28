import type { QueryFilter } from "./filter-query";

import { childrenOf, type Node, type TreeIndex } from "./tree";
import {
  contentIdForKey,
  findVisibleNeighbor,
  instanceIdForKey,
} from "./visible-order";

/**
 * Backspace at the start of a bullet that HAS text merges it into the row above
 * -- the inverse of the Enter split (`splitNode`). This module is the pure
 * planner half: it decides whether a merge is legal and, when it is, names the
 * target row, the seam the caret must land on, and the text to carry over. The
 * impure shell (`onJoinPrevious` in OutlineEditor) runs the protection/mirror
 * guards and applies the plan in ONE `runStructural` batch (ADR 0009).
 *
 * It lives in its own leaf rather than in `tree.ts` because the hidden-between
 * rule needs `findVisibleNeighbor`, and `visible-order.ts` already imports
 * `tree.ts` -- a planner there would close an import cycle. DOM-free and
 * React-free, so `bun test` can exercise every eligibility rule directly (the
 * `planRemoveSubtrees` shape).
 */

/** Why a merge was refused. The planner only names the reason; the disclosure
 *  layer (`components/join-refusal.ts`) maps each to a shake and/or a toast. */
export type JoinRefusal =
  | "has-children"
  | "hidden-between"
  | "no-target"
  | "mirror-row";

export type JoinPlan =
  | {
      kind: "join";
      /** The target's render key -- what `pendingFocus` / `rowOf()` speak. */
      targetKey: string;
      /** The target's instance (position) id. */
      targetId: string;
      /** Where the target's text actually lives: `mirrorOf ?? id` (ADR 0022). */
      targetContentId: string;
      /** The target's SOURCE-space text length BEFORE the append -- the exact
       *  offset the caret must land on, correct even when either side ends or
       *  begins with a folded token (ADR 0005). */
      seamOffset: number;
      /** The disappearing row's text, appended to the target's verbatim. */
      sourceText: string;
    }
  | {
      /**
       * The row above is EMPTY, so the merge is spelled the other way round:
       * remove the blank and leave this node completely alone -- same id, text,
       * children, caret. Visually identical to appending onto a blank, but it
       * keeps IDENTITY on the node that carries the text.
       *
       * That matters because Enter at the start of a bullet inserts an empty
       * sibling above and leaves focus put, so Enter-then-Backspace is a round
       * trip a user reads as an undo. Appending would quietly move the text onto
       * the blank's id, out from under every bookmark / [[link]] / daily mapping
       * pointing at it -- the exact identity move the Enter-at-start arm exists
       * to avoid (#326, "Enter at the start makes room above"). Here the NODE
       * BEING DELETED is the target, so the shell guards that end instead.
       */
      kind: "remove-empty-target";
      targetKey: string;
      targetId: string;
      targetContentId: string;
    }
  | { kind: "refuse"; reason: JoinRefusal };

/** The no-op prune for the structural walk: nothing is hidden. */
const NOTHING_HIDDEN: (n: Node) => boolean = () => false;

/**
 * Plan a Backspace-join of the row `activeKey` into the row visually above it.
 *
 * The eligibility walk, in order:
 *
 * 1. **has-children** -- a bullet with children is refused, never reparented.
 *    The children are on screen, so the reason is self-evident.
 * 2. **mirror-row** -- the row being merged AWAY must not be a mirror instance:
 *    its text belongs to a shared source that survives the join, so the merge
 *    would copy the text into the target while it still exists everywhere else.
 *    (A mirror as the *target* is fine -- appending edits the shared source,
 *    which is exactly how editing a mirror already works.)
 * 3. **hidden-between** -- two walks: what the user SEES (collapse +
 *    hide-completed + an active `?q=`) versus what they'd see with only collapse
 *    applied. When they disagree, something invisible sits between the two rows
 *    and a merge would relocate text past a node the user can't see. Collapse is
 *    deliberately NOT disqualifying: a collapsed node's descendants aren't
 *    visible rows in either walk, so both land on the collapsed node itself --
 *    which is the right target.
 * 4. **no-target** -- nothing above (the first row under a zoom root already
 *    resolves to the root's own title key, which IS a legal target). Also the
 *    self-referential shape: a mirror of THIS node rendering directly above it
 *    resolves its content back to us, which would be a write-then-delete of one
 *    node (refused as `mirror-row`).
 *
 * Then one of two plans, depending on the target:
 *
 * - **remove-empty-target** -- the row above is empty, so the blank goes and
 *   this node is left untouched. Identical on screen to appending onto it, but
 *   identity stays with the text (see the kind's own doc comment).
 * - **join** -- the ordinary merge: the target keeps its id and gains this
 *   node's text, this row disappears, and the caret lands at the seam.
 *
 * Pure; no DOM, no React, no collection reads.
 */
export function planJoinPrevious(
  index: TreeIndex,
  activeKey: string,
  viewRootId: string | null,
  isHidden: (n: Node) => boolean,
  filter: QueryFilter | null,
  mirrorsEnabled: boolean,
): JoinPlan {
  const instanceId = instanceIdForKey(activeKey);
  const instance = index.byId.get(instanceId);
  if (!instance) return { kind: "refuse", reason: "no-target" };

  // Off the mirrors flag a `mirrorOf` node is just a normal node (ADR 0022), so
  // content === instance and neither the mirror refusal nor the resolution runs.
  const contentId = mirrorsEnabled
    ? (instance.mirrorOf ?? instanceId)
    : instanceId;
  const content = index.byId.get(contentId);
  if (!content) return { kind: "refuse", reason: "no-target" };

  if (childrenOf(index, contentId).length > 0) {
    return { kind: "refuse", reason: "has-children" };
  }
  if (contentId !== instanceId) {
    return { kind: "refuse", reason: "mirror-row" };
  }

  // What the user sees...
  const shown = findVisibleNeighbor(
    index,
    viewRootId,
    activeKey,
    "up",
    isHidden,
    filter,
    mirrorsEnabled,
  );
  // ...versus what they'd see with ONLY collapse applied. When no filter is
  // active and nothing is pruned, the two walks are identical by construction,
  // so the common path pays one cheap comparison and never over-refuses.
  const structural = findVisibleNeighbor(
    index,
    viewRootId,
    activeKey,
    "up",
    NOTHING_HIDDEN,
    null,
    mirrorsEnabled,
  );
  if (shown !== structural) return { kind: "refuse", reason: "hidden-between" };
  if (!shown) return { kind: "refuse", reason: "no-target" };

  const targetKey = shown;
  const targetId = instanceIdForKey(targetKey);
  const targetContentId = mirrorsEnabled
    ? contentIdForKey(index, targetKey)
    : targetId;
  const target = index.byId.get(targetContentId);
  if (!target) return { kind: "refuse", reason: "no-target" };
  // A mirror of THIS node sitting directly above it resolves its content back to
  // us, so the plan would be self-referential: `setText(S, …)` followed by
  // `removeNode(S)` destroys the node AND the text. `guardMirrorSourceDelete` in
  // the shell refuses this first today, but that is incidental -- the planner
  // must not be able to emit a write-then-delete of the same node regardless of
  // what the shell does with it, or reorders it.
  if (targetContentId === instanceId) {
    return { kind: "refuse", reason: "mirror-row" };
  }

  // Merging INTO a blank line is just "remove the blank line" -- same result on
  // screen, but this node keeps its id (see the kind's own doc comment).
  if (target.text.length === 0) {
    return {
      kind: "remove-empty-target",
      targetKey,
      targetId,
      targetContentId,
    };
  }

  return {
    kind: "join",
    targetKey,
    targetId,
    targetContentId,
    seamOffset: target.text.length,
    sourceText: content.text,
  };
}
