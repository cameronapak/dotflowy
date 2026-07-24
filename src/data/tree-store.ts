import type { ChangeMessage } from "@tanstack/react-db";

import { useCallback, useRef, useSyncExternalStore } from "react";

import type { QueryFilter } from "./filter-query";

import { isSyncReady, nodesCollection, subscribeSyncReady } from "./collection";
import { isLunoraSyncEnabled, isMirrorsEnabled } from "./flags";
import { parseNodeLinks } from "./node-links";
import { parseTags } from "./tags";
import {
  buildTreeIndex,
  buildTrail,
  childrenOf,
  orderChildIds,
  parentKeyOf,
  type Node,
  type TreeIndex,
} from "./tree";
import { buildVisibleRows, type VisibleRow } from "./visible-order";

/**
 * A single, app-wide subscription to the nodes collection that derives one
 * shared {@link TreeIndex} and lets components subscribe to *narrow slices* of
 * it via {@link useNode}, {@link useVisibleChildIds}, {@link useTrail}, and
 * {@link useHasNodes} -- each re-rendering only when its own slice changes
 * identity, so the editor shell no longer re-renders on every keystroke.
 *
 * Why this exists: `useLiveQuery(nodesCollection)` rebuilds a brand-new `index`
 * object on every edit. Threading that object as a prop into every `OutlineRow`
 * defeats `React.memo` (a changed reference fails the shallow compare), so a
 * single keystroke re-rendered the entire visible tree -- O(visible nodes) per
 * keystroke, measured at 300 commits on a 300-node outline. See ADR 0014.
 *
 * The fix is a pull model: each `OutlineRow` reads *its own* node and child-id
 * list from this store. Because TanStack DB preserves object identity for
 * unchanged rows (an edit is an Immer draft of one row), `useNode`'s snapshot is
 * referentially stable for every node except the one that actually changed -- so
 * `useSyncExternalStore` re-renders only that node. `useVisibleChildIds` returns
 * a memoized id array that only changes identity when the *structure* (the set
 * or order of visible children) changes, never when a child's text changes.
 */

const EMPTY_INDEX: TreeIndex = buildTreeIndex([]);
const EMPTY_IDS: string[] = [];
const EMPTY_TRAIL: Node[] = [];

// The store owns ONE mutable index, maintained in place by applyChanges. It must
// be its own instance -- never the shared EMPTY_INDEX, which has to stay pristine
// as the server/initial snapshot for the hooks below.
let index: TreeIndex = {
  byId: new Map(),
  childrenByParent: new Map(),
  mirrorsBySource: new Map(),
  linksByTarget: new Map(),
  tagCorpus: new Map(),
};
const listeners = new Set<() => void>();
let started = false;

// Monotonic counter bumped only when the VISIBLE STRUCTURE changes -- an
// insert/delete/reparent/reorder (dirty parents) OR a collapse/completed flip
// (field edits that nonetheless add/remove rows or change fade inheritance). A
// plain text/isTask edit never bumps it, so {@link useVisibleRows}' getSnapshot
// is an O(1) rev compare on the typing hot path and rebuilds the flat list only
// on a real structural change -- the Phase B counterpart to the field-edit Map
// identity discipline below (ADR 0019).
let structureRev = 0;

function notify() {
  for (const l of listeners) l();
}

/**
 * Apply a batch of collection changes to the shared index IN PLACE, rather than
 * rebuilding it from scratch. This is the Phase A scaling win (ADR 0019 / PRD
 * scale-outline): a text/field keystroke (the hot path) touches neither
 * `parentId` nor `prevSiblingId`, so it dirties NO parent -- the work is a single
 * `byId.set`, O(1), versus the old `buildTreeIndex(toArray)` that ran O(total
 * nodes) on EVERY change. Only inserts, deletes, reparents, and reorders touch
 * `childrenByParent`, and only the affected parents are re-sorted.
 *
 * INVARIANT -- do NOT "simplify" this back to `index = buildTreeIndex(toArray)`:
 * that reintroduces the O(n)-per-keystroke rebuild this exists to kill.
 *
 * Why id arrays + byId (see tree.ts): every node read goes through `byId`, so a
 * text edit never has to find-and-replace a stale node object inside a sibling
 * array. `change.value` is the FULL row (TanStack DB `ChangeMessage`), so the
 * parentId/prevSiblingId comparisons below are reliable.
 *
 * Re-sort EVERY parent whose membership or sibling order changed -- insert,
 * delete, reparent-from, reparent-to, reorder -- re-derived from the batch's
 * FINAL `byId`. A removal does not "keep the rest ordered" in general: a
 * multi-write structural op is transiently inconsistent mid-batch (a delete
 * repoints the follower's prevSiblingId *and* deletes the node, so two siblings
 * briefly share one prev -- a "fan"), and only a re-sort from the settled state
 * fixes it. This is exactly what the old `buildTreeIndex(toArray)` did by
 * re-deriving on every change; we just scope the re-sort to touched parents.
 * Field-only edits touch no parent, so they re-sort nothing and stay O(1).
 *
 * NOTE: this kills the index-rebuild O(n). The remaining O(visible) per-keystroke
 * cost is the `useVisibleChildIds` getSnapshot fan-out across *mounted* parents
 * -- that's what Phase B's windowing cuts, not this.
 */
function applyChanges(changes: ReadonlyArray<ChangeMessage<Node>>) {
  const dirty = new Set<string>(); // parents whose child order may have changed
  // A collapse or completed flip is a field edit (no parent dirties) but it DOES
  // change the visible row set / fade inheritance, so it must bump structureRev
  // for useVisibleRows even though it keeps the Map refs (it's not a re-sort).
  // `completed`/`collapsed` are the only fields that affect visibility today
  // (hide-completed Seam-G + collapse). If a future Seam-G transform hides a node
  // by another field, add it here or useVisibleRows will show stale rows.
  let visibilityChanged = false;
  // mirrorOf transitions (create/promote — ADR 0022) are rare and ride structural
  // batches today, but tracked independently so the reverse index stays correct
  // (and its Map identity is refreshed) even on a bare field edit that flips it.
  let mirrorsChanged = false;
  // Outbound-link transitions (ADR 0032): a text edit that completes or deletes
  // a `[[id]]` token. Tracked like mirrorsChanged so the backlink reverse index
  // refreshes on a bare field edit; parseNodeLinks bails on link-free text, so
  // the keystroke hot path pays two `includes` scans of the edited node's text.
  let linksChanged = false;
  // Tag-corpus transitions (the tags.ts split): a text edit that adds/removes a
  // `#tag`. Tracked the same way as linksChanged; parseTags bails on tag-free
  // text so a tag-free keystroke pays the same cheap `includes` scan.
  let tagsChanged = false;
  for (const change of changes) {
    if (change.type === "delete") {
      const prev = index.byId.get(change.key as string);
      if (!prev) continue;
      index.byId.delete(prev.id);
      const key = parentKeyOf(prev);
      removeChildId(key, prev.id);
      dirty.add(key);
      if (prev.mirrorOf) {
        removeMirror(prev.mirrorOf, prev.id);
        mirrorsChanged = true;
      }
      for (const target of parseNodeLinks(prev.text)) {
        removeLink(target, prev.id);
        linksChanged = true;
      }
      for (const tag of parseTags(prev.text)) {
        removeTagOccurrence(tag);
        tagsChanged = true;
      }
      continue;
    }
    const next = change.value;
    const prev = index.byId.get(next.id);
    index.byId.set(next.id, next);
    if ((prev?.text ?? "") !== next.text) {
      const before = prev ? parseNodeLinks(prev.text) : [];
      const after = parseNodeLinks(next.text);
      if (before.length > 0 || after.length > 0) {
        for (const t of before) {
          if (!after.includes(t)) {
            removeLink(t, next.id);
            linksChanged = true;
          }
        }
        for (const t of after) {
          if (!before.includes(t)) {
            addLink(t, next.id);
            linksChanged = true;
          }
        }
      }
      const tagsBefore = prev ? parseTags(prev.text) : [];
      const tagsAfter = parseTags(next.text);
      if (tagsBefore.length > 0 || tagsAfter.length > 0) {
        for (const t of tagsBefore) {
          if (!tagsAfter.includes(t)) {
            removeTagOccurrence(t);
            tagsChanged = true;
          }
        }
        for (const t of tagsAfter) {
          if (!tagsBefore.includes(t)) {
            addTagOccurrence(t);
            tagsChanged = true;
          }
        }
      }
    }
    if (
      prev &&
      (prev.collapsed !== next.collapsed || prev.completed !== next.completed)
    ) {
      visibilityChanged = true;
    }
    if ((prev?.mirrorOf ?? null) !== (next.mirrorOf ?? null)) {
      // null<->id or id<->id: leave the old source's bucket, join the new one.
      if (prev?.mirrorOf) removeMirror(prev.mirrorOf, next.id);
      if (next.mirrorOf) addMirror(next.mirrorOf, next.id);
      mirrorsChanged = true;
    }
    if (!prev) {
      // Insert (also the safe fallback for an update to a row we haven't seen).
      const key = parentKeyOf(next);
      addChildId(key, next.id);
      dirty.add(key);
    } else if (prev.parentId !== next.parentId) {
      // Reparent: leaves the old parent, joins the new -- both need a re-sort.
      const from = parentKeyOf(prev);
      const to = parentKeyOf(next);
      removeChildId(from, next.id);
      addChildId(to, next.id);
      dirty.add(from);
      dirty.add(to);
    } else if (prev.prevSiblingId !== next.prevSiblingId) {
      // Reorder within the same parent.
      dirty.add(parentKeyOf(next));
    }
    // else: a field-only edit (text / completed / ...) -- byId.set above is all.
  }
  for (const key of dirty) {
    const ids = index.childrenByParent.get(key);
    if (ids) index.childrenByParent.set(key, orderChildIds(index.byId, ids));
  }
  // Identity discipline. Always bump the WRAPPER so `useTreeIndex` re-renders
  // (the focus/flash effect in OutlineEditor subscribes to it purely to re-run
  // after every tree change -- in-place-only would freeze its identity and focus
  // would stop landing).
  //
  // On a STRUCTURAL change (dirty.size > 0 -- insert/delete/reparent/reorder) also
  // hand out FRESH Maps: whole-collection readers, and the React Compiler's
  // inferred deps, memoize on the byId / childrenByParent *reference* (e.g. the
  // Cmd+K switcher's `Array.from(index.byId.values())`), so mutating in place
  // would leave them stale -- a just-created node would never appear in search.
  // The Map copy is O(n), but it only rides discrete structural actions (Enter,
  // Delete, move), never the per-keystroke path, and it's still cheaper than the
  // old buildTreeIndex (no re-bucketing/re-sort of the whole outline). Node refs
  // are shared by the copy, so per-node `useNode` stays stable.
  //
  // Field-only edits (the hot path) keep the SAME Map refs -- O(1). Per-node
  // reactivity flows through `useNode` (node-object identity), not Map identity,
  // and whole-collection readers are inert while a bullet is being edited.
  const structural = dirty.size > 0;
  index = {
    byId: structural ? new Map(index.byId) : index.byId,
    childrenByParent: structural
      ? new Map(index.childrenByParent)
      : index.childrenByParent,
    // Copy the reverse-index Map on a structural change (it rides the same fresh-
    // Maps discipline as the others) OR whenever a mirrorOf flipped, so readers
    // memoized on its reference can't go stale. Untouched on the keystroke path.
    mirrorsBySource:
      structural || mirrorsChanged
        ? new Map(index.mirrorsBySource)
        : index.mirrorsBySource,
    // Same discipline for the backlink reverse index (ADR 0032): fresh on a
    // structural change or when a text edit flipped an outbound link. A plain
    // (link-free) keystroke keeps the reference.
    linksByTarget:
      structural || linksChanged
        ? new Map(index.linksByTarget)
        : index.linksByTarget,
    // Same discipline for the tag corpus: fresh on a structural change or when a
    // text edit added/removed a tag. A tag-free keystroke keeps the reference.
    tagCorpus:
      structural || tagsChanged ? new Map(index.tagCorpus) : index.tagCorpus,
  };
  // Bump the flat-list signal on a structural change OR a visibility flip; a
  // pure text/isTask edit leaves it untouched (the typing hot path). See
  // useVisibleRows.
  if (dirty.size > 0 || visibilityChanged) structureRev++;
  notify();
}

/** Append an id to a parent's child list (the dirty re-sort fixes its position).
 *  Guards against a duplicate from a redelivered change. */
function addChildId(key: string, id: string) {
  const ids = index.childrenByParent.get(key);
  if (ids) {
    if (!ids.includes(id)) ids.push(id);
  } else {
    index.childrenByParent.set(key, [id]);
  }
}

/** Drop an id from a parent's child list; prune the entry when it empties. The
 *  caller marks the parent dirty so it's re-sorted from the settled byId (a
 *  mid-batch removal can leave a transient fan -- see applyChanges). */
function removeChildId(key: string, id: string) {
  const ids = index.childrenByParent.get(key);
  if (!ids) return;
  const i = ids.indexOf(id);
  if (i !== -1) ids.splice(i, 1);
  if (ids.length === 0) index.childrenByParent.delete(key);
}

/** Register a mirror id under its source in the reverse index (ADR 0022).
 *  Guards against a duplicate from a redelivered change. */
function addMirror(sourceId: string, id: string) {
  const ids = index.mirrorsBySource.get(sourceId);
  if (ids) {
    if (!ids.includes(id)) ids.push(id);
  } else {
    index.mirrorsBySource.set(sourceId, [id]);
  }
}

/** Drop a mirror id from its source's bucket; prune the entry when it empties. */
function removeMirror(sourceId: string, id: string) {
  const ids = index.mirrorsBySource.get(sourceId);
  if (!ids) return;
  const i = ids.indexOf(id);
  if (i !== -1) ids.splice(i, 1);
  if (ids.length === 0) index.mirrorsBySource.delete(sourceId);
}

/** Register a referring node under a link target in the backlink reverse index
 *  (ADR 0032). Guards against a duplicate from a redelivered change. */
function addLink(targetId: string, referrerId: string) {
  const ids = index.linksByTarget.get(targetId);
  if (ids) {
    if (!ids.includes(referrerId)) ids.push(referrerId);
  } else {
    index.linksByTarget.set(targetId, [referrerId]);
  }
}

/** Drop a referrer from a target's backlink bucket; prune when it empties. */
function removeLink(targetId: string, referrerId: string) {
  const ids = index.linksByTarget.get(targetId);
  if (!ids) return;
  const i = ids.indexOf(referrerId);
  if (i !== -1) ids.splice(i, 1);
  if (ids.length === 0) index.linksByTarget.delete(targetId);
}

/** Register one occurrence of `tag` in the maintained corpus (the tags.ts
 *  split): first-seen casing wins the entry's display `tag`, same rule
 *  `collectAllTags` applies in a full rebuild. */
function addTagOccurrence(tag: string) {
  const key = tag.toLowerCase();
  const entry = index.tagCorpus.get(key);
  if (entry) entry.count++;
  else index.tagCorpus.set(key, { tag, count: 1 });
}

/** Drop one occurrence; prune the entry once its count reaches zero (the tag no
 *  longer appears anywhere in the outline). */
function removeTagOccurrence(tag: string) {
  const key = tag.toLowerCase();
  const entry = index.tagCorpus.get(key);
  if (!entry) return;
  entry.count--;
  if (entry.count <= 0) index.tagCorpus.delete(key);
}

/**
 * Begin the one collection subscription, lazily. `includeInitialState` makes the
 * callback fire immediately with the current rows (delivered as inserts), so the
 * first read is already populated; every later change is folded into the shared
 * index incrementally and notifies. Skipped on the server (SPA + prerender, no
 * socket) -- see ADR 0004.
 *
 * Lunora flag-swap (ADR 0055): `lunora-sync.ts` owns the subscription and calls
 * {@link resetTreeFromNodes} — do not also subscribe to the idle `nodesCollection`.
 */
function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (isLunoraSyncEnabled()) return;
  nodesCollection.subscribeChanges((changes) => applyChanges(changes), {
    includeInitialState: true,
  });
}

/**
 * Replace the shared index from a full node list (Lunora `wholeOutline` feed).
 * Used when the Lunora sync flag is ON — a full rebuild is fine for dogfood
 * outlines; the incremental `applyChanges` path stays on the custom-DO flag-OFF
 * path.
 */
export function resetTreeFromNodes(nodes: readonly Node[]): void {
  ensureStarted();
  index = buildTreeIndex([...nodes]);
  structureRev++;
  notify();
}

/**
 * Subscribe to any change in the shared tree index. Exported so the editor
 * shell's own narrow slice hooks ({@link useTrail}, {@link useHasNodes}, and the
 * registry's `useViewFilter`) fold the same single collection subscription --
 * each re-renders only when its cached snapshot's identity changes, never on an
 * unrelated keystroke. See ADR 0014.
 */
export function subscribeTree(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * The current shared index, read live OUTSIDE render (event handlers, command
 * closures, drag, undo/redo). Render reads must use {@link useTreeIndex} /
 * {@link useNode} instead, so they stay reactive. Touching it starts the
 * subscription on first use.
 */
export function getTreeIndex(): TreeIndex {
  ensureStarted();
  return index;
}

/** Whole-index subscription. Re-renders on every change -- use sparingly. */
export function useTreeIndex(): TreeIndex {
  return useSyncExternalStore(subscribeTree, getTreeIndex, () => EMPTY_INDEX);
}

/**
 * Subscribe to a single node. Re-renders only when *that* node's object changes
 * (identity is stable for unchanged rows), so an edit to one bullet never
 * re-renders its siblings.
 */
export function useNode(id: string): Node | undefined {
  const getSnapshot = useCallback(() => getTreeIndex().byId.get(id), [id]);
  return useSyncExternalStore(subscribeTree, getSnapshot, () => undefined);
}

/** A no-op store subscription, for hooks switched off by a session-fixed flag:
 *  no listener is registered and it never notifies, so the snapshot stays at its
 *  disabled value for the session. */
const NOOP_SUBSCRIBE = () => () => {};

/**
 * Subscribe to how many mirror INSTANCES point at `id` as their source (ADR
 * 0022) -- the number behind the "appears in N places" chrome. A primitive
 * snapshot, so a row re-renders only when its source's mirror count actually
 * changes (create / promote / delete), never on a keystroke -- the same per-node
 * budget as {@link useNode} / `useIsProtected`.
 *
 * `enabled` is the session-fixed mirrors flag, read once by the caller. When off
 * the hook subscribes to nothing and reports 0, so a mirror-free outline adds
 * zero reactive work to the hot path -- the "don't regress" rule (ADR 0019/0022).
 * Always called (rules of hooks); only the subscribe target varies by the stable
 * flag.
 */
export function useMirrorCount(id: string, enabled = true): number {
  const getSnapshot = useCallback(
    () => (enabled ? (getTreeIndex().mirrorsBySource.get(id)?.length ?? 0) : 0),
    [id, enabled],
  );
  return useSyncExternalStore(
    enabled ? subscribeTree : NOOP_SUBSCRIBE,
    getSnapshot,
    () => 0,
  );
}

/**
 * Subscribe to how many nodes LINK to `id` (ADR 0032) -- the number behind the
 * zoomed view's "{n} backlinks" line. Deduped by referring node (the reverse
 * index stores each referrer once regardless of how many times its text repeats
 * the token). A primitive snapshot, so the one mounted consumer (the zoomed
 * title's chrome) re-renders only when the count actually changes.
 */
export function useBacklinkCount(id: string): number {
  const getSnapshot = useCallback(
    () => getTreeIndex().linksByTarget.get(id)?.length ?? 0,
    [id],
  );
  return useSyncExternalStore(subscribeTree, getSnapshot, () => 0);
}

/**
 * Subscribe to a node's ordered, visibility-filtered child ids. `isHidden` is
 * the composed Seam-G prune predicate (ADR 0001): the store no longer hardcodes
 * `completed` -- it hides whatever the predicate hides (hide-completed today).
 * It must be referentially stable across keystrokes (the caller memoizes it on
 * its inputs), or this cache resets every render and parents re-render on typing.
 *
 * The returned array keeps its identity until the *structure* changes (insert,
 * delete, reorder, or a prune that flips visibility) -- a child's text change
 * leaves it untouched, so the parent does not re-render on typing.
 */
export function useVisibleChildIds(
  parentId: string | null,
  isHidden: (node: Node) => boolean,
): string[] {
  // Cache the last (key, ids) so getSnapshot returns a referentially stable
  // array while the structure is unchanged. Starts null -- the first call
  // always populates, so there is no sentinel key to collide with.
  const cache = useRef<{ key: string; ids: string[] } | null>(null);
  const getSnapshot = useCallback(() => {
    const kids = childrenOf(getTreeIndex(), parentId);
    const ids: string[] = [];
    for (const n of kids) if (!isHidden(n)) ids.push(n.id);
    const key = ids.join("\n");
    if (!cache.current || cache.current.key !== key)
      cache.current = { key, ids };
    return cache.current.ids;
  }, [parentId, isHidden]);
  return useSyncExternalStore(subscribeTree, getSnapshot, () => EMPTY_IDS);
}

/**
 * Subscribe to the breadcrumb trail of `rootId` -- its ancestors top-down,
 * including the node itself (see {@link buildTrail}). The cached array keeps its
 * identity until a *displayed* crumb changes: its id (the path structure) OR its
 * text (the label the breadcrumb renders). So typing in a bullet that is NOT on
 * the trail leaves the shell untouched, while renaming an ancestor's title does
 * update the crumb. Same stable-snapshot trick as {@link useVisibleChildIds}.
 */
export function useTrail(rootId: string | null): Node[] {
  const cache = useRef<{ key: string; trail: Node[] } | null>(null);
  const getSnapshot = useCallback(() => {
    const trail = buildTrail(getTreeIndex(), rootId);
    let key = "";
    for (const n of trail) key += `${n.id}\0${n.text}\n`;
    if (!cache.current || cache.current.key !== key)
      cache.current = { key, trail };
    return cache.current.trail;
  }, [rootId]);
  return useSyncExternalStore(subscribeTree, getSnapshot, () => EMPTY_TRAIL);
}

/**
 * Whether the store has loaded any nodes. A primitive boolean snapshot, so it
 * only re-renders when emptiness flips (once, on initial load) -- never on a
 * keystroke. Lets the shell tell "deep link to a deleted node" (show the
 * not-found notice) apart from "store still loading" (render nothing yet).
 */
export function useHasNodes(): boolean {
  return useSyncExternalStore(
    subscribeTree,
    () => getTreeIndex().byId.size > 0,
    () => false,
  );
}

/**
 * Whether the first sync frame has landed (see {@link isSyncReady}). A primitive
 * boolean snapshot that flips once, so it re-renders the shell exactly when
 * loading ends -- never on a keystroke. The shell gates its loading spinner on
 * `!ready`, which (unlike {@link useHasNodes}) tells a not-yet-synced outline
 * apart from a genuinely empty new account.
 */
export function useSyncReady(): boolean {
  return useSyncExternalStore(subscribeSyncReady, isSyncReady, () => false);
}

/** The current visible-structure revision (see {@link structureRev}). O(1). */
export function getStructureRev(): number {
  ensureStarted();
  return structureRev;
}

const EMPTY_ROWS: VisibleRow[] = [];

/**
 * The flat, depth-tagged list of visible rows under `rootId` -- the windowed
 * render driver (ADR 0019). One subscription feeds the whole windowed list;
 * {@link useVisibleChildIds} stays per-row (a row's own children slice).
 *
 * Identity discipline (the reason this is cheap at 100k): getSnapshot rebuilds
 * the array ONLY when {@link structureRev} changes -- a structural edit or a
 * collapse/completed flip. A plain keystroke bumps nothing, so getSnapshot is an
 * O(1) rev compare and returns the SAME array reference, so the virtualizer host
 * doesn't re-render on typing. `isHidden` and `filter` are deps of the memoized
 * callback (a new filter object on a matching keystroke while filtering forces a
 * rebuild -- correct, and not the 100k hot path). They must be referentially
 * stable across unrelated keystrokes (the caller memoizes them), or the cache
 * resets every render.
 *
 * Mirror resolution (ADR 0022) is gated on {@link isMirrorsEnabled}, read here
 * rather than threaded as a dep: the flag is fixed for a session (set before the
 * first render), so a flip is picked up on the next structural rebuild -- it
 * never needs to invalidate the keystroke-hot cache.
 */
export function useVisibleRows(
  rootId: string | null,
  isHidden: (node: Node) => boolean,
  filter: QueryFilter | null,
): VisibleRow[] {
  const cache = useRef<{
    rev: number;
    rootId: string | null;
    isHidden: (n: Node) => boolean;
    filter: QueryFilter | null;
    rows: VisibleRow[];
  } | null>(null);
  const getSnapshot = useCallback(() => {
    const rev = getStructureRev();
    const c = cache.current;
    // Reuse only when NOTHING that shapes the list changed: rev (structure) AND
    // the deps (the cache outlives a getSnapshot swap, so a dep change with an
    // unchanged rev would otherwise return rows built for the old deps).
    if (
      c &&
      c.rev === rev &&
      c.rootId === rootId &&
      c.isHidden === isHidden &&
      c.filter === filter
    ) {
      return c.rows;
    }
    const rows = buildVisibleRows(
      getTreeIndex(),
      rootId,
      isHidden,
      filter,
      isMirrorsEnabled(),
    );
    cache.current = { rev, rootId, isHidden, filter, rows };
    return rows;
  }, [rootId, isHidden, filter]);
  return useSyncExternalStore(subscribeTree, getSnapshot, () => EMPTY_ROWS);
}
