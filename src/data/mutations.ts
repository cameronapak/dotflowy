import { nodesCollection } from "./collection";
import { isLunoraSyncEnabled } from "./flags";
import { getLunoraOutlineContext, trackLunoraMutation } from "./lunora-sync";
import {
  type Node,
  type NodeKind,
  type TreeIndex,
  buildTreeIndex,
  childrenOf,
  createId,
  makeNode,
  now,
  trueSourceOf,
  wouldMirrorCycle,
} from "./tree";

/**
 * All mutations operate on the nodesCollection directly (LocalStorage
 * collections are mutated imperatively; persistence is automatic).
 *
 * Every function takes the current TreeIndex so it can find siblings /
 * ordering without re-deriving it. The caller (OutlineEditor) holds the
 * live-derived index.
 */

function update(nodeId: string, patch: Partial<Node>) {
  nodesCollection.update(nodeId, (draft) => {
    Object.assign(draft, patch, { updatedAt: now() });
  });
}

/**
 * Insert a fresh empty node as the next sibling of `afterId`, or as the
 * new last child of `parentId` when afterId is null.
 *
 * `isTask` lets the caller carry the node type forward so pressing Enter at
 * the end of a task creates another task (not a plain bullet). `kind` carries
 * paragraph-ness forward the same way (ADR 0045), so Enter in a paragraph makes
 * another paragraph and a mid-text split leaves two of them.
 *
 * `text` seeds the new node's text -- used by the Enter-mid-bullet split, where
 * everything right of the caret moves into this new sibling.
 *
 * `id` lets a caller supply the node id up front (the daily plugin mints it
 * before an atomic claim, then splices the winner in at a sorted slot); defaults
 * to a fresh id.
 *
 * Returns the new node's id so the editor can focus it.
 */
export function insertSibling(
  index: TreeIndex,
  parentId: string | null,
  afterId: string | null,
  isTask = false,
  text = "",
  kind: NodeKind = null,
  id = createId(),
): string {
  // ADR 0055: Lunora mutator owns optimistic plan + watermark (dogfood surface).
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      const t = now();
      trackLunoraMutation(
        lunora.store.mutators.insertSibling({
          id,
          userId: lunora.userId,
          parentId,
          afterId,
          text,
          isTask,
          kind,
          createdAt: t,
          updatedAt: t,
        }),
      );
      return id;
    }
  }

  const prevSiblingId = afterId;

  // The node currently following `afterId` becomes the new node's follower.
  let nextSiblingId: string | null = null;
  if (afterId) {
    const siblings = childrenOf(index, parentId);
    const i = siblings.findIndex((n) => n.id === afterId);
    if (i !== -1 && i + 1 < siblings.length) {
      nextSiblingId = siblings[i + 1]!.id;
    }
  }

  nodesCollection.insert(
    makeNode({ id, parentId, prevSiblingId, text, isTask, kind }),
  );

  // Repoint the follower at the new node.
  if (nextSiblingId) {
    update(nextSiblingId, { prevSiblingId: id });
  }

  return id;
}

/**
 * Insert a fresh empty node as the FIRST child of `parentId`, pushing the
 * current head (if any) down. Used when pressing Enter on a zoomed node's
 * title: the new bullet should appear directly under the title.
 *
 * `id` lets a caller supply the node id up front (the daily plugin mints it
 * before an atomic claim, so the winner inserts the node under the id the claim
 * settled on). Defaults to a fresh id.
 *
 * Returns the new node's id so the editor can focus it.
 */
export function insertChildAtStart(
  index: TreeIndex,
  parentId: string | null,
  isTask = false,
  text = "",
  id = createId(),
  kind: NodeKind = null,
): string {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      const t = now();
      trackLunoraMutation(
        lunora.store.mutators.insertChildAtStart({
          id,
          userId: lunora.userId,
          parentId,
          text,
          isTask,
          kind,
          createdAt: t,
          updatedAt: t,
        }),
      );
      return id;
    }
  }

  const head = childrenOf(index, parentId)[0] ?? null;

  nodesCollection.insert(
    makeNode({ id, parentId, prevSiblingId: null, text, isTask, kind }),
  );

  // The old head now follows the new node.
  if (head) update(head.id, { prevSiblingId: id });

  return id;
}

/**
 * Enter mid-split: leave `leftText` on `nodeId`, insert a sibling carrying
 * `rightText`. Lunora path is ONE mutator (single watermark); custom-DO path
 * is insertSibling + setText inside the caller's `runStructural` batch.
 */
export function splitNode(
  index: TreeIndex,
  args: {
    nodeId: string;
    parentId: string | null;
    afterId: string;
    leftText: string;
    rightText: string;
    isTask?: boolean;
    kind?: NodeKind;
    newId?: string;
  },
): string {
  const newId = args.newId ?? createId();
  const isTask = args.isTask ?? false;
  const kind = args.kind ?? null;

  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      const t = now();
      trackLunoraMutation(
        lunora.store.mutators.splitNode({
          id: args.nodeId,
          newId,
          userId: lunora.userId,
          parentId: args.parentId,
          afterId: args.afterId,
          leftText: args.leftText,
          rightText: args.rightText,
          isTask,
          kind,
          createdAt: t,
          updatedAt: t,
        }),
      );
      return newId;
    }
  }

  insertSibling(
    index,
    args.parentId,
    args.afterId,
    isTask,
    args.rightText,
    kind,
    newId,
  );
  setText(args.nodeId, args.leftText);
  return newId;
}

/**
 * Append a node at the end of `parentId`'s children. Used by the
 * first-run seed, where we don't have a live TreeIndex in scope and the
 * caller knows the parent is empty or has a known last child.
 *
 * Pass `prevSiblingId` explicitly so seed code owns the wiring. `id` lets a
 * caller supply the node id up front (the daily plugin's claimed container id);
 * defaults to a fresh id.
 */
export function appendChild(
  parentId: string | null,
  prevSiblingId: string | null = null,
  text = "",
  id = createId(),
): string {
  nodesCollection.insert(makeNode({ id, parentId, prevSiblingId, text }));
  return id;
}

/**
 * Create a MIRROR of `sourceId` as the last child of `targetId` (or the last
 * top-level node when targetId is null/Home) -- a node carrying `mirrorOf` ->
 * the TRUE source (ADR 0022). Two invariants:
 *
 *  - **Flatten:** if `sourceId` is itself a mirror, the new node points at its
 *    source (`trueSourceOf`), never at another mirror, so every instance shares
 *    ONE canonical content node and there's no chain to resolve.
 *  - **No cycle:** refuses (returns null) when the true source is the
 *    destination or one of its ancestors -- expanding such a mirror would window
 *    content that contains the mirror itself.
 *
 * The stored `text` snapshots the source so a mirror still reads sensibly with
 * the feature flag OFF; with mirrors ON the field split reads the live source,
 * so the snapshot is never shown. Returns the new node's id, or null when
 * blocked / the source is gone. Wrap in `runStructural` (ADR 0009).
 */
export function mirrorNode(
  index: TreeIndex,
  sourceId: string,
  targetId: string | null,
): string | null {
  if (!index.byId.has(sourceId)) return null;
  const trueSourceId = trueSourceOf(index, sourceId);
  if (wouldMirrorCycle(index, trueSourceId, targetId)) return null;

  const id = createId();

  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      // Resolve destination + cycle on the server planner (trueSourceOf parent).
      // Pre-check above matches the legacy client path for early no-op.
      const t = now();
      const resolvedParent =
        targetId !== null ? trueSourceOf(index, targetId) : null;
      if (wouldMirrorCycle(index, trueSourceId, resolvedParent)) return null;
      trackLunoraMutation(
        lunora.store.mutators.mirrorNode({
          id,
          userId: lunora.userId,
          sourceId,
          targetParentId: targetId,
          createdAt: t,
          updatedAt: t,
        }),
      );
      return id;
    }
  }

  const siblings = childrenOf(index, targetId);
  const after = siblings.length ? siblings[siblings.length - 1]!.id : null;
  nodesCollection.insert(
    makeNode({
      id,
      parentId: targetId,
      prevSiblingId: after,
      text: index.byId.get(trueSourceId)?.text ?? "",
      mirrorOf: trueSourceId,
    }),
  );
  return id;
}

/**
 * Mirror several sources under `targetId`, appended in order (node multi-
 * selection's Mirror action + daily "Mirror to Today" -- ADR 0018). Rebuilds the
 * index between inserts so each append reads the freshly grown sibling list;
 * sources that would cycle (or are gone) are skipped. Returns the count actually
 * mirrored. Wrap in `runStructural` (ADR 0009).
 */
export function mirrorManyNodes(
  targetId: string | null,
  ids: string[],
): number {
  let made = 0;
  for (const id of ids) {
    const index = buildTreeIndex(nodesCollection.toArray);
    if (mirrorNode(index, id, targetId)) made++;
  }
  return made;
}

/**
 * Indent: move `nodeId` to become the last child of its previous sibling.
 * No-op if it's already the first child of its parent.
 *
 * Returns true if a move happened.
 *
 * Effect on siblings:
 *  - node's old next sibling's prevSiblingId becomes node's old prevSiblingId
 *  - node's prevSiblingId becomes the previous sibling's id (now its parent)
 *
 * `resolveMirror` (ADR 0022): when the previous sibling is a MIRROR, parent into
 * its SOURCE instead of the instance id, so the node windows into every instance
 * -- matching the drag path. The caller passes `isMirrorsEnabled()`; it's a param
 * (not a `flags.ts` read) so this module stays pure, and OFF it runs today's exact
 * code (byte-identical: no mirror boundary crossed).
 */
export function indent(
  index: TreeIndex,
  nodeId: string,
  resolveMirror = false,
): boolean {
  const node = index.byId.get(nodeId);
  if (!node || !node.prevSiblingId) return false;

  // ADR 0055 dogfood: skip mirror-resolution path (mirrors still on custom DO).
  if (isLunoraSyncEnabled() && !resolveMirror) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.indent({
          id: nodeId,
          userId: lunora.userId,
          updatedAt: now(),
        }),
      );
      return true;
    }
  }

  const newParent = index.byId.get(node.prevSiblingId);
  if (!newParent) return false;

  // Resolve BEFORE the child read and parentId write below, or a mirror prev
  // sibling parents the node under the INSTANCE id, whose row renders the
  // source's children and never the node -> it vanishes. Off-flag this is the id
  // itself. Collapse-expand still targets the VISIBLE instance (`newParent.id`)
  // -- collapse is a local field.
  const newParentContentId = resolveMirror
    ? trueSourceOf(index, newParent.id)
    : newParent.id;

  // Cycle guard (ADR 0022 + ADR 0010): mirror resolution can point
  // `newParentContentId` at `nodeId` itself (a mirror of `nodeId` sitting as its
  // prev sibling) or at a descendant of `nodeId`, which would self-parent the
  // node and corrupt the tree. `indent` splices raw (not via `moveNode`), so it
  // must guard the way `moveNode` does. A no-op off-flag (the prev sibling can
  // never be `nodeId` or its descendant), so flag-OFF stays byte-identical.
  if (resolveMirror) {
    let cursor: Node | undefined = index.byId.get(newParentContentId);
    let guard = index.byId.size + 1;
    while (cursor && guard-- > 0) {
      if (cursor.id === nodeId) return false;
      cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined;
    }
  }

  const oldParent = node.parentId;
  const oldSiblings = childrenOf(index, oldParent);
  const i = oldSiblings.findIndex((n) => n.id === nodeId);
  const oldNext =
    i !== -1 && i + 1 < oldSiblings.length ? oldSiblings[i + 1]! : null;

  // The node becomes the LAST child of newParent, so read newParent's current
  // last child BEFORE moving it. The shared tree index is maintained IN PLACE
  // (tree-store applyChanges), and an update can notify synchronously, so a read
  // AFTER the move can already include the node itself -- it would then point its
  // own prevSiblingId at itself (a self-referencing chain). node is a sibling of
  // newParent here, never already its child, so the pre-move read excludes it.
  const newSiblings = childrenOf(index, newParentContentId);
  const lastExisting =
    newSiblings.length > 0 ? newSiblings[newSiblings.length - 1]! : null;

  // Node becomes last child of newParent. If that parent was collapsed, the
  // node would be indented out of sight, so expand it to keep the node visible.
  update(nodeId, {
    parentId: newParentContentId,
    prevSiblingId: lastExisting ? lastExisting.id : null,
  });
  if (newParent.collapsed) update(newParent.id, { collapsed: false });

  // Old next sibling links back to node's old prev.
  if (oldNext) {
    update(oldNext.id, { prevSiblingId: node.prevSiblingId });
  }

  return true;
}

/**
 * Outdent: move `nodeId` up one level. It becomes the sibling immediately
 * after its former parent.
 *
 * No-op if the node is already top-level (parentId === null).
 *
 * Effect:
 *  - node's parent becomes its grandparent
 *  - node's prevSiblingId becomes its old parent's id
 *  - node's old next sibling (under old parent) repoints to node's old prevSiblingId
 *  - the node that used to follow the old parent now repoints to node
 */
export function outdent(index: TreeIndex, nodeId: string): boolean {
  const node = index.byId.get(nodeId);
  if (!node || node.parentId === null) return false;

  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.outdent({
          id: nodeId,
          userId: lunora.userId,
          updatedAt: now(),
        }),
      );
      return true;
    }
  }

  const oldParent = index.byId.get(node.parentId);
  if (!oldParent) return false;

  const newParentId = oldParent.parentId;

  // Siblings under old parent.
  const oldSiblings = childrenOf(index, oldParent.id);
  const i = oldSiblings.findIndex((n) => n.id === nodeId);
  const oldNext =
    i !== -1 && i + 1 < oldSiblings.length ? oldSiblings[i + 1]! : null;

  // Siblings under new parent (i.e. old parent's level), used to find the
  // node that currently follows oldParent so we can splice node in between.
  const newSiblings = childrenOf(index, newParentId);
  const parentIdx = newSiblings.findIndex((n) => n.id === oldParent.id);
  const afterParent =
    parentIdx !== -1 && parentIdx + 1 < newSiblings.length
      ? newSiblings[parentIdx + 1]!
      : null;

  // Move node up.
  update(nodeId, {
    parentId: newParentId,
    prevSiblingId: oldParent.id,
  });

  // Old next sibling (under old parent) relinks to node's old prev.
  if (oldNext) {
    update(oldNext.id, { prevSiblingId: node.prevSiblingId });
  }

  // The node that followed oldParent now follows node.
  if (afterParent) {
    update(afterParent.id, { prevSiblingId: nodeId });
  }

  return true;
}

interface MoveOpts {
  /**
   * Show-completed predicate. A move targets the nearest *visible* sibling,
   * skipping hidden completed ones (they ride along, staying hidden), so a
   * press is never a dead no-visible-change move. Defaults to "all visible".
   */
  isVisible?: (n: Node) => boolean;
  /**
   * Boundary parent (the zoom root). A node directly under it must not escape
   * the visible subtree, so an edge move there is a no-op. See ADR 0009.
   */
  rootId?: string | null;
  /**
   * Resolve a mirror uncle/aunt to its SOURCE at an edge reparent (ADR 0022), so
   * the moved node windows into every instance instead of vanishing under the
   * instance id. The caller passes `isMirrorsEnabled()`; OFF (default) it's
   * today's exact behavior. Kept a param, not a `flags.ts` read, to keep this
   * module pure (matches the drag call site).
   */
  resolveMirror?: boolean;
}

/**
 * Edge helper for move-up: reparent into the parent's previous sibling as its
 * last child (Workflowy-style "nudge up" into the uncle subtree).
 */
function reparentIntoParentPrevSibling(
  index: TreeIndex,
  node: Node,
  rootId: string | null,
  resolveMirror: boolean,
): boolean {
  if (node.parentId === null || node.parentId === rootId) return false;
  const parent = index.byId.get(node.parentId);
  if (!parent?.prevSiblingId) return false;

  const uncleId = parent.prevSiblingId;
  // ADR 0022: a mirror uncle windows its SOURCE's children, so land there (both
  // the last-child read and the move target). Off-flag it's the id itself;
  // collapse-expand stays on the visible instance.
  const uncleContentId = resolveMirror ? trueSourceOf(index, uncleId) : uncleId;
  const uncleChildren = childrenOf(index, uncleContentId);
  const afterSiblingId =
    uncleChildren.length > 0
      ? uncleChildren[uncleChildren.length - 1]!.id
      : null;

  const uncle = index.byId.get(uncleId);
  const expandIds = uncle?.collapsed ? [uncle.id] : [];

  return moveNode(index, node.id, uncleContentId, afterSiblingId, expandIds);
}

/**
 * Edge helper for move-down: reparent into the parent's next sibling as its
 * first child (Workflowy-style "nudge down" into the aunt subtree).
 */
function reparentIntoParentNextSibling(
  index: TreeIndex,
  node: Node,
  rootId: string | null,
  resolveMirror: boolean,
): boolean {
  if (node.parentId === null || node.parentId === rootId) return false;
  const parent = index.byId.get(node.parentId);
  if (!parent) return false;

  const parentSiblings = childrenOf(index, parent.parentId);
  const pi = parentSiblings.findIndex((n) => n.id === parent.id);
  const aunt =
    pi !== -1 && pi + 1 < parentSiblings.length
      ? parentSiblings[pi + 1]!
      : null;
  if (!aunt) return false;

  // ADR 0022: a mirror aunt windows its SOURCE's children; parent into the
  // source (off-flag it's the id itself). Collapse stays on the instance.
  const auntContentId = resolveMirror ? trueSourceOf(index, aunt.id) : aunt.id;
  const expandIds = aunt.collapsed ? [aunt.id] : [];
  return moveNode(index, node.id, auntContentId, null, expandIds);
}

/**
 * Move `nodeId` up among its siblings. If a visible sibling sits above it,
 * swap with that sibling (same depth, subtree carried). Otherwise (it is the
 * first visible child) reparent into the parent's previous sibling as its last
 * child.
 *
 * Returns true if a move happened. See ADR 0009.
 */
export function moveUp(
  index: TreeIndex,
  nodeId: string,
  opts: MoveOpts = {},
): boolean {
  const isVisible = opts.isVisible ?? (() => true);
  const node = index.byId.get(nodeId);
  if (!node) return false;

  const siblings = childrenOf(index, node.parentId);
  const i = siblings.findIndex((n) => n.id === nodeId);
  if (i === -1) return false;

  // Nearest visible sibling above, skipping hidden completed ones.
  let vp: Node | null = null;
  for (let j = i - 1; j >= 0; j--) {
    if (isVisible(siblings[j]!)) {
      vp = siblings[j]!;
      break;
    }
  }

  if (!vp)
    return reparentIntoParentPrevSibling(
      index,
      node,
      opts.rootId ?? null,
      opts.resolveMirror ?? false,
    );

  // Swap via moveNode: land immediately before vp (same parent).
  return moveNode(index, nodeId, node.parentId, vp.prevSiblingId ?? null);
}

/**
 * Move `nodeId` down among its siblings. If a visible sibling sits below it,
 * swap with that sibling. Otherwise (it is the last visible child) reparent
 * into the parent's next sibling as its first child.
 *
 * Returns true if a move happened. See ADR 0009.
 */
export function moveDown(
  index: TreeIndex,
  nodeId: string,
  opts: MoveOpts = {},
): boolean {
  const isVisible = opts.isVisible ?? (() => true);
  const node = index.byId.get(nodeId);
  if (!node) return false;

  const siblings = childrenOf(index, node.parentId);
  const i = siblings.findIndex((n) => n.id === nodeId);
  if (i === -1) return false;

  // Nearest visible sibling below, skipping hidden completed ones.
  let k = -1;
  for (let j = i + 1; j < siblings.length; j++) {
    if (isVisible(siblings[j]!)) {
      k = j;
      break;
    }
  }

  if (k === -1) {
    return reparentIntoParentNextSibling(
      index,
      node,
      opts.rootId ?? null,
      opts.resolveMirror ?? false,
    );
  }

  // Swap via moveNode: land immediately after the nearest visible sibling below.
  const vn = siblings[k]!;
  return moveNode(index, nodeId, node.parentId, vn.id);
}

/**
 * Move `nodeId` to be a child of `newParentId`, positioned immediately after
 * `afterSiblingId` (or as the first child when `afterSiblingId` is null). This
 * is the fused move that drag-and-drop performs: it changes parent AND sibling
 * order in one shot, unlike the keyboard moves which only ever do one. See
 * ADR 0010.
 *
 * Returns true if a real move happened. No-ops (and returns false) when the
 * target is the node's current position, or when the move would create a cycle
 * (dropping a node into its own subtree).
 *
 * Like every mutation here it reads sibling order from the pre-mutation `index`
 * and relinks the `prevSiblingId` chain: detach the node (its old next sibling
 * inherits its old prev), then splice it in (the node that followed the new
 * slot now follows the node).
 */
export function moveNode(
  index: TreeIndex,
  nodeId: string,
  newParentId: string | null,
  afterSiblingId: string | null,
  expandIds: readonly string[] = [],
): boolean {
  const node = index.byId.get(nodeId);
  if (!node) return false;
  // Can't land after yourself, and can't become your own parent.
  if (afterSiblingId === nodeId || newParentId === nodeId) return false;

  // Cycle guard: walk up from the target parent; bail if we reach the node.
  // Dropping a branch inside itself would orphan it. See ADR 0010.
  if (newParentId !== null) {
    let cursor: Node | undefined = index.byId.get(newParentId);
    let guard = index.byId.size + 1;
    while (cursor && guard-- > 0) {
      if (cursor.id === nodeId) return false;
      cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined;
    }
  }

  // Already exactly here? Nothing to do (same parent, same predecessor).
  if (
    newParentId === node.parentId &&
    (afterSiblingId ?? null) === (node.prevSiblingId ?? null) &&
    expandIds.length === 0
  ) {
    return false;
  }

  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.moveNode({
          id: nodeId,
          userId: lunora.userId,
          newParentId,
          afterSiblingId,
          updatedAt: now(),
          expandIds: expandIds.length ? [...expandIds] : undefined,
        }),
      );
      return true;
    }
  }

  for (const expandId of expandIds) {
    update(expandId, { collapsed: false });
  }

  // Same-spot with only expands (edge move that lands where we already are but
  // still needed to open the uncle) — already handled above when expandIds
  // empty; with expands and same spot, skip chain surgery.
  if (
    newParentId === node.parentId &&
    (afterSiblingId ?? null) === (node.prevSiblingId ?? null)
  ) {
    return expandIds.length > 0;
  }

  // The node currently following us under the OLD parent inherits our old prev.
  const oldSiblings = childrenOf(index, node.parentId);
  const oi = oldSiblings.findIndex((n) => n.id === nodeId);
  const oldNext =
    oi !== -1 && oi + 1 < oldSiblings.length ? oldSiblings[oi + 1]! : null;

  // The node that will follow us under the NEW parent: the one after
  // `afterSiblingId`, or the current head when we're becoming the first child.
  const newSiblings = childrenOf(index, newParentId);
  let newNext: Node | null = null;
  if (afterSiblingId === null) {
    newNext = newSiblings[0] ?? null;
  } else {
    const ni = newSiblings.findIndex((n) => n.id === afterSiblingId);
    newNext =
      ni !== -1 && ni + 1 < newSiblings.length ? newSiblings[ni + 1]! : null;
  }

  // Detach, then re-splice. Reads above are all from the pre-mutation index, so
  // ordering of the writes below doesn't matter.
  if (oldNext) update(oldNext.id, { prevSiblingId: node.prevSiblingId });
  update(nodeId, { parentId: newParentId, prevSiblingId: afterSiblingId });
  if (newNext && newNext.id !== nodeId) {
    update(newNext.id, { prevSiblingId: nodeId });
  }
  return true;
}

/**
 * Move several nodes to be the last children of `targetId`, in the given order
 * (node multi-selection's Move + daily's Send to Today -- ADR 0018). Returns how
 * many actually moved.
 *
 * Each node is appended after the previously-moved one, so the run keeps its
 * relative order under the target. The index is REBUILT from the live collection
 * before each `moveNode` (the prior move already applied optimistically to
 * `nodesCollection`), so sibling-chain relinks read accurate state -- looping
 * `moveNode` over a stale snapshot would tear the chain when the moved nodes
 * were siblings of each other. Wrap the whole call in `runStructural` so the N
 * moves land as ONE atomic batch (ADR 0009).
 */
export function moveManyNodes(targetId: string | null, ids: string[]): number {
  let moved = 0;
  // `after` walks forward: start at the target's current last child, then each
  // successful move becomes the predecessor of the next.
  const firstSiblings = childrenOf(
    buildTreeIndex(nodesCollection.toArray),
    targetId,
  );
  let after: string | null = firstSiblings.length
    ? firstSiblings[firstSiblings.length - 1]!.id
    : null;
  for (const id of ids) {
    const index = buildTreeIndex(nodesCollection.toArray);
    if (moveNode(index, id, targetId, after)) {
      moved++;
      after = id;
    }
  }
  return moved;
}

/**
 * Indent a contiguous sibling run (node multi-selection's Tab -- ADR 0018): move
 * every selected root to become the last children of the run's PREVIOUS sibling,
 * preserving order. No-op (returns 0) when the run is already the first child of
 * its parent (no previous sibling to indent under). The new parent is expanded if
 * collapsed so the indented run stays visible (mirrors single-node `indent`).
 * Reuses `moveManyNodes`, so it's the same rebuild-between-moves batch; wrap the
 * whole call in `runStructural` so it lands as ONE atomic frame (ADR 0009).
 */
export function indentManyNodes(
  rootIds: string[],
  resolveMirror = false,
): number {
  if (rootIds.length === 0) return 0;
  const index = buildTreeIndex(nodesCollection.toArray);
  // The run is contiguous, so the first root's prev sibling sits OUTSIDE it --
  // the node everything indents under. Absent => first child => can't indent.
  const targetId = index.byId.get(rootIds[0]!)?.prevSiblingId;
  if (!targetId) return 0;
  if (index.byId.get(targetId)?.collapsed)
    update(targetId, { collapsed: false });
  // ADR 0022: a mirror target parents the run into its SOURCE (matches single
  // `indent`). Off-flag it's the id itself; the collapse-expand above still
  // targets the visible instance.
  const target = resolveMirror ? trueSourceOf(index, targetId) : targetId;
  // If the mirror target resolves INTO the selected run (its prev sibling is a
  // mirror of a selected root or one of their descendants), `moveManyNodes` would
  // skip the cyclic node via `moveNode`'s guard and silently split the run. Abort
  // the whole indent instead (a no-op). Only reachable under mirror resolution.
  if (resolveMirror && target !== targetId) {
    const selected = new Set(rootIds);
    let cursor: string | null = target;
    let guard = index.byId.size + 1;
    while (cursor && guard-- > 0) {
      if (selected.has(cursor)) return 0;
      cursor = index.byId.get(cursor)?.parentId ?? null;
    }
  }
  return moveManyNodes(target, rootIds);
}

/**
 * Outdent a contiguous sibling run (node multi-selection's Shift+Tab -- ADR 0018):
 * move every selected root up one level, landing them immediately after their
 * former shared parent, in order. No-op (returns 0) when the run is already
 * top-level. The zoom-root boundary is the CALLER's guard (it owns view state),
 * mirroring single-node `onOutdent`. Like `moveManyNodes` it rebuilds the index
 * between moves so the sibling chain stays intact -- looping over a stale snapshot
 * would land later roots before earlier ones (each lands "right after the parent",
 * displacing the prior). Wrap in `runStructural` (ADR 0009).
 */
export function outdentManyNodes(rootIds: string[]): number {
  if (rootIds.length === 0) return 0;
  const start = buildTreeIndex(nodesCollection.toArray);
  const oldParentId = start.byId.get(rootIds[0]!)?.parentId;
  if (!oldParentId) return 0; // already top-level -> can't outdent
  const newParentId = start.byId.get(oldParentId)?.parentId ?? null;
  let moved = 0;
  // `after` walks forward from the old parent: each root lands right after the
  // previously-moved one, so the run keeps its order at the new level.
  let after: string = oldParentId;
  for (const id of rootIds) {
    const index = buildTreeIndex(nodesCollection.toArray);
    if (moveNode(index, id, newParentId, after)) {
      moved++;
      after = id;
    }
  }
  return moved;
}

/**
 * Delete a node. Children are deleted recursively (Workflowy behavior:
 * deleting a parent deletes its subtree). Returns the id to focus
 * afterwards: the next sibling if any, else the previous sibling, else
 * the parent.
 */
export function removeNode(index: TreeIndex, nodeId: string): string | null {
  const node = index.byId.get(nodeId);
  if (!node) return null;

  // Determine focus target before mutating (shared by Lunora + custom-DO paths).
  const siblings = childrenOf(index, node.parentId);
  const i = siblings.findIndex((n) => n.id === nodeId);
  let focusId: string | null = null;
  if (i !== -1 && i + 1 < siblings.length) {
    focusId = siblings[i + 1]!.id;
  } else if (i > 0) {
    focusId = siblings[i - 1]!.id;
  } else {
    focusId = node.parentId;
  }

  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.removeNode({
          id: nodeId,
          userId: lunora.userId,
          updatedAt: now(),
        }),
      );
      return focusId;
    }
  }

  // Collect subtree ids (depth-first).
  const toDelete: string[] = [];
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    toDelete.push(id);
    const kids = childrenOf(index, id);
    for (const k of kids) stack.push(k.id);
  }

  // Relink the follower of the last-deleted-in-chain. For the deleted node
  // itself, its old next sibling needs to point at node.prevSiblingId.
  if (i !== -1 && i + 1 < siblings.length) {
    const nextSibling = siblings[i + 1]!;
    update(nextSibling.id, { prevSiblingId: node.prevSiblingId });
  }

  for (const id of toDelete) nodesCollection.delete(id);

  // focusId may have been deleted if it was in the subtree (it isn't, by
  // construction: focus is a sibling or ancestor), so it's safe.
  return focusId;
}

/**
 * Delete several nodes and their subtrees (node multi-selection's Delete --
 * ADR 0018). The index is REBUILT from the live collection before each
 * `removeNode`, so the sibling-chain relink reads accurate state: deleting a run
 * of contiguous siblings off ONE stale snapshot would dangle the chain (each
 * delete repoints the follower to the just-deleted node's prev). Order-agnostic
 * with the rebuild. Wrap in `runStructural` so the whole set is one atomic batch.
 * Focus handling is the caller's (computed before deletion).
 */
export function removeManyNodes(ids: string[]): void {
  for (const id of ids) {
    removeNode(buildTreeIndex(nodesCollection.toArray), id);
  }
}

export function setText(nodeId: string, text: string) {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.setText({
          id: nodeId,
          userId: lunora.userId,
          text,
          updatedAt: now(),
        }),
      );
      return;
    }
  }
  update(nodeId, { text });
}

export function toggleCompleted(nodeId: string, completed: boolean) {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.setCompleted({
          id: nodeId,
          userId: lunora.userId,
          completed,
          updatedAt: now(),
        }),
      );
      return;
    }
  }
  update(nodeId, { completed });
}

/**
 * Make a bullet a task (gains a checkbox) or a plain bullet. `isTask` is
 * purely a display choice and is independent of `completed`: a plain bullet
 * keeps whatever done-status it had. See ADR 0001.
 *
 * Clearing `kind` is the ONE half of the kind exclusivity invariant this funnel
 * owns (ADR 0045): bullet | task | paragraph are mutually exclusive, and the
 * two-field encoding cannot say so, so every make-it-a-task gesture (`/todo`,
 * the `[]` autoformat) and every back-to-a-plain-bullet gesture (`/bullet`,
 * Backspace on the checkbox) writes both fields in one PATCH. Redundant on a
 * node that was already `kind: null` — and that's the point: it can't be
 * forgotten at a call site.
 */
export function setIsTask(nodeId: string, isTask: boolean) {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.setIsTask({
          id: nodeId,
          userId: lunora.userId,
          isTask,
          updatedAt: now(),
        }),
      );
      return;
    }
  }
  update(nodeId, { isTask, kind: null });
}

/**
 * Make a node a paragraph (a paragraph glyph where the dot would be) or, with `null`,
 * a plain bullet. The other half of the exclusivity invariant: a paragraph is
 * never a task, so this clears `isTask`. See ADR 0045.
 *
 * A FIELD edit, like `setIsTask` — a single-field PATCH, already atomic. Never
 * wrap it in `runStructural`.
 */
export function setKind(nodeId: string, kind: NodeKind) {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.setKind({
          id: nodeId,
          userId: lunora.userId,
          kind,
          updatedAt: now(),
        }),
      );
      return;
    }
  }
  update(nodeId, { kind, isTask: false });
}

export function toggleCollapsed(nodeId: string, collapsed: boolean) {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      trackLunoraMutation(
        lunora.store.mutators.setCollapsed({
          id: nodeId,
          userId: lunora.userId,
          collapsed,
          updatedAt: now(),
        }),
      );
      return;
    }
  }
  update(nodeId, { collapsed });
}

/**
 * Pin or unpin a node as a bookmark. Stores the moment it was pinned (the
 * bookmarks list sorts by it) or `null` to unpin. See ADR 0011.
 */
export function toggleBookmark(nodeId: string, bookmarked: boolean) {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      const t = now();
      trackLunoraMutation(
        lunora.store.mutators.setBookmarkedAt({
          id: nodeId,
          userId: lunora.userId,
          bookmarkedAt: bookmarked ? t : null,
          updatedAt: t,
        }),
      );
      return;
    }
  }
  update(nodeId, { bookmarkedAt: bookmarked ? now() : null });
}
