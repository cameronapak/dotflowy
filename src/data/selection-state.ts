import { useSelector } from "@xstate/react";
import { Schema } from "effect";
import { createActor, setup } from "xstate";

import { nodesCollection } from "./collection";
import { buildTreeIndex, childrenOf, type Node, type TreeIndex } from "./tree";
import { getTreeIndex } from "./tree-store";
import { getViewIsHidden, getViewRootId } from "./view-state";

/**
 * Node multi-selection state (ADR 0018), modelled as an XState v6 machine whose
 * context + events are typed by Effect Schema (ADR 0020). A second editing mode
 * where whole *nodes* are selected (distinct from selecting text inside one
 * bullet), so an action can act on several subtrees at once.
 *
 * Why a state machine: the mode is genuinely two-state -- `idle` (a text caret,
 * no selection) and `selecting` (a run of nodes, no caret) -- and the
 * while-selected keys are pure event-routing-by-state. Making that explicit is
 * the legibility win; the gnarly tree derivation (mirroring the render's visible
 * prune, walking by depth at a sibling boundary) stays in the pure helpers
 * below, which the transitions call at EVENT time via the live getters
 * (`getTreeIndex`/`getViewRootId`/...), exactly the ADR 0004 idiom.
 *
 * Shape: the actor is a MODULE SINGLETON (`createActor(...).start()`), NOT a
 * `useMachine` -- it's mirrored like {@link view-state} and the tree store. The
 * stable command/keyboard closures read it live at event time (`getSnapshot`),
 * and each row subscribes to its OWN slice via {@link useSelectionEdge} (now
 * `@xstate/react`'s `useSelector` with an edge-equality compare), so a selection
 * change re-renders only the rows entering or leaving it -- preserving ADR 0014's
 * per-node-render budget. Selection is NEVER threaded as a prop. The public API
 * of this module is unchanged from the pre-XState version; only the internals
 * moved into the machine, so a rollback is "restore the old file + drop two deps".
 *
 * Model: a selection is a **contiguous run of siblings under one parent**
 * (`rootIds`), and selecting a node implies its whole subtree (you select roots;
 * descendants come along). The fixed end is the `anchorId`; Shift+arrow moves the
 * `focusId` end. Because the run is always sibling-scoped, every operation on it
 * (copy, delete, move) has an unambiguous meaning. See ADR 0018.
 *
 * Caret and selection are mutually exclusive: while nodes are selected there is
 * no text caret. The editor enforces that (focusing any bullet clears the
 * selection); this module just holds the data.
 */

/** Where a selected ROOT sits in the slab: the first/last get rounded outer
 *  corners, the lone root rounds all four, middles round nothing. Only roots
 *  carry an edge -- a root's `<li>` background tints its whole subtree, so
 *  descendants need no per-row marker. Null means "not a selected root". */
export type SelectionEdge = "top" | "bottom" | "middle" | "single";

/**
 * Effect Schema for one live selection. It TYPES the machine context (via
 * `toStandardSchemaV1` -> XState's Standard Schema slot); there is no untrusted
 * input here, so it's a type source, not a runtime guard. `rootIds` is anchor..
 * focus inclusive, in visible display order; subtrees are implied, not listed.
 */
const SelectionDataSchema = Schema.Struct({
  /** The shared parent of every selected root (the run is sibling-scoped). */
  parentId: Schema.NullOr(Schema.String),
  /** The fixed end of the run (where the selection started). */
  anchorId: Schema.String,
  /** The moving end (Shift+arrow walks this). */
  focusId: Schema.String,
  /** The selected sibling roots, in visible display order. */
  rootIds: Schema.Array(Schema.String),
});
/** Exported for {@link "./selection-fill"}'s coverage walk -- a type-only need,
 *  not a widening of the frozen function API (ADR 0020). */
export type SelectionData = Schema.Schema.Type<typeof SelectionDataSchema>;

/** Machine context: the current selection, or null while idle. One field, so a
 *  transition just replaces it; a no-op transition returns nothing and the
 *  reference is preserved (which is what keeps the store snapshots stable). */
const ContextSchema = Schema.Struct({
  data: Schema.NullOr(SelectionDataSchema),
});

// --- pure derivation (reads the live tree at event time) --------------------

/** The visible siblings under `parentId`, mirroring the render's Seam-G prune
 *  (hide-completed today) so the selectable run matches what's on screen. The
 *  tag filter's separate prune is intentionally NOT applied here (v1: selecting
 *  while a tag filter is active is out of scope). */
function visibleSiblings(index: TreeIndex, parentId: string | null): Node[] {
  const isHidden = getViewIsHidden();
  return childrenOf(index, parentId).filter((n) => !isHidden(n));
}

/**
 * The visible sibling run between `anchorId` and `focusId` (inclusive), under
 * the anchor's parent. If the two aren't siblings (or the focus has scrolled out
 * of the visible set) the run collapses to the anchor. Returns null (-> clear)
 * if the anchor is gone. Pure: no mutation, no notify -- the machine owns those.
 */
function computeRange(
  anchorId: string,
  focusId: string,
  index: TreeIndex = getTreeIndex(),
): SelectionData | null {
  const anchor = index.byId.get(anchorId);
  if (!anchor) return null;
  const parentId = anchor.parentId;
  const sibs = visibleSiblings(index, parentId);
  const ai = sibs.findIndex((n) => n.id === anchorId);
  if (ai === -1) return null;
  let fi = sibs.findIndex((n) => n.id === focusId);
  if (fi === -1) fi = ai; // focus not a visible sibling -> collapse to anchor
  const lo = Math.min(ai, fi);
  const hi = Math.max(ai, fi);
  const rootIds = sibs.slice(lo, hi + 1).map((n) => n.id);
  return { parentId, anchorId, focusId: sibs[fi]!.id, rootIds };
}

/**
 * Move the focus end one visible sibling in `direction` (Shift+arrow). Reversing
 * direction shrinks back toward the anchor before extending the other way -- a
 * property of the anchor/focus model, not special-cased.
 *
 * At the first/last visible sibling the run can't extend further among siblings.
 * For a MULTI-root run that edge is a no-op (returns the same data) -- the run
 * never spans parents (ADR 0018). For a SINGLE-root selection it instead MOVES by
 * depth: Up selects the parent, Down dives into the first visible child. Climbing
 * stops at the zoom root; diving needs an expanded node with a visible child.
 * Never returns null -- extension never clears.
 */
function computeExtend(
  data: SelectionData,
  direction: "up" | "down",
): SelectionData {
  const index = getTreeIndex();
  const sibs = visibleSiblings(index, data.parentId);
  const fi = sibs.findIndex((n) => n.id === data.focusId);
  if (fi === -1) return data;
  const ni = direction === "down" ? fi + 1 : fi - 1;
  if (ni >= 0 && ni < sibs.length) {
    return computeRange(data.anchorId, sibs[ni]!.id, index) ?? data;
  }
  // Sibling boundary. Single-root selections walk by depth; multi-root no-ops.
  if (data.rootIds.length !== 1) return data;
  if (direction === "up") {
    // Climb to the parent. Stop at the zoom root (parentId === the view root, or
    // null at the top level) -- the view root isn't a selectable node.
    if (data.parentId === null || data.parentId === getViewRootId())
      return data;
    return computeRange(data.parentId, data.parentId, index) ?? data;
  }
  // Dive into the first visible child. Collapsed nodes render no children.
  const node = index.byId.get(data.focusId);
  if (!node || node.collapsed) return data;
  const kids = visibleSiblings(index, data.focusId);
  if (kids.length === 0) return data;
  return computeRange(kids[0]!.id, kids[0]!.id, index) ?? data;
}

/** Every visible top-level child of the current view (Cmd+A rung 3 -- the zoom
 *  root's subtree). Null when the view is empty. */
function computeAllInView(): SelectionData | null {
  const index = getTreeIndex();
  const sibs = visibleSiblings(index, getViewRootId());
  if (sibs.length === 0) return null;
  return computeRange(sibs[0]!.id, sibs[sibs.length - 1]!.id, index);
}

/** id -> edge map for one selection, built once and reused for every row. Keyed
 *  on the `SelectionData` reference (stable per selection -- a no-op transition
 *  preserves it), so it rebuilds only when the selection actually changes, and a
 *  replaced `SelectionData` is GC'd with its map. This keeps `edgeOf` O(1) per
 *  row instead of an O(rootIds) `indexOf` on every subscribed row per snapshot
 *  (the pre-XState `recomputeEdges` behavior). */
const edgeMaps = new WeakMap<SelectionData, Map<string, SelectionEdge>>();
function edgeMapFor(data: SelectionData): Map<string, SelectionEdge> {
  let m = edgeMaps.get(data);
  if (m) return m;
  m = new Map();
  const ids = data.rootIds;
  if (ids.length === 1) {
    m.set(ids[0]!, "single");
  } else {
    m.set(ids[0]!, "top");
    m.set(ids[ids.length - 1]!, "bottom");
    for (let i = 1; i < ids.length - 1; i++) m.set(ids[i]!, "middle");
  }
  edgeMaps.set(data, m);
  return m;
}

/** The slab edge for a node id given the current selection, or null when it
 *  isn't a selected root. O(1): consults the memoized {@link edgeMapFor} map, so
 *  the `useSelector` selector stays cheap across every subscribed row. */
function edgeOf(id: string, data: SelectionData | null): SelectionEdge | null {
  if (!data) return null;
  return edgeMapFor(data).get(id) ?? null;
}

// --- the machine ------------------------------------------------------------

const selectionMachine = setup({
  schemas: {
    context: Schema.toStandardSchemaV1(ContextSchema),
    events: {
      "select.single": Schema.toStandardSchemaV1(
        Schema.Struct({ nodeId: Schema.String }),
      ),
      "select.all": Schema.toStandardSchemaV1(Schema.Struct({})),
      extend: Schema.toStandardSchemaV1(
        Schema.Struct({ direction: Schema.Literals(["up", "down"]) }),
      ),
      refresh: Schema.toStandardSchemaV1(Schema.Struct({})),
      clear: Schema.toStandardSchemaV1(Schema.Struct({})),
    },
  },
}).createMachine({
  context: { data: null },
  initial: "idle",
  states: {
    // No caret-bound selection. `extend`/`refresh` don't exist here -- you can't
    // extend what doesn't exist -- so a stray Shift+arrow can't no-op into a bug.
    idle: {
      on: {
        "select.single": ({ event }) => {
          const d = computeRange(event.nodeId, event.nodeId);
          return d ? { target: "selecting", context: { data: d } } : undefined;
        },
        "select.all": () => {
          const d = computeAllInView();
          return d ? { target: "selecting", context: { data: d } } : undefined;
        },
      },
    },
    // A run of nodes is selected; no text caret is focused.
    selecting: {
      on: {
        "select.single": ({ event }) => {
          const d = computeRange(event.nodeId, event.nodeId);
          return d
            ? { context: { data: d } }
            : { target: "idle", context: { data: null } };
        },
        "select.all": () => {
          const d = computeAllInView();
          // Empty view: keep the current selection (matches the old no-op).
          return d ? { context: { data: d } } : undefined;
        },
        extend: ({ context, event }) => {
          if (!context.data) return undefined;
          return {
            context: { data: computeExtend(context.data, event.direction) },
          };
        },
        // Re-derive (parentId + rootIds) from the LIVE collection, same
        // anchor/focus, after a structural mutation relocates the run
        // (indent/outdent). Reads `nodesCollection` directly so it's correct
        // synchronously inside the same `runStructural` batch, before the tree
        // store's subscription has rebuilt. ids + order are unchanged by an
        // indent/outdent, so only `parentId` shifts.
        refresh: ({ context }) => {
          if (!context.data) return undefined;
          const d = computeRange(
            context.data.anchorId,
            context.data.focusId,
            buildTreeIndex(nodesCollection.toArray),
          );
          return d
            ? { context: { data: d } }
            : { target: "idle", context: { data: null } };
        },
        clear: () => ({ target: "idle", context: { data: null } }),
      },
    },
  },
});

/** The one long-lived actor for this tab's selection. Started in `idle`; no
 *  transition runs (and so nothing touches the collection) until an event is
 *  sent, keeping module load side-effect-free (SPA/no-SSR safe). */
const selectionActor = createActor(selectionMachine).start();

const snapshot = () => selectionActor.getSnapshot();

// --- public API (now backed by the actor) -----------------------------------

/** The selected ROOT ids (subtrees implied), in visible order. Empty when no
 *  selection. Stable identity per selection -- safe as a store snapshot (the
 *  context array is only replaced when the selection actually changes). */
const EMPTY_ROOTS: string[] = [];
export function getSelectionRootIds(): string[] {
  const d = snapshot().context.data;
  // Variance-only cast: callers read but never mutate (the schema types it
  // readonly); preserving the `string[]` public signature avoids a ripple.
  return d ? (d.rootIds as string[]) : EMPTY_ROOTS;
}

/** The full selection state, read live at event time. Null when inactive. */
export function getSelectionState(): SelectionData | null {
  return snapshot().context.data;
}

/** Select exactly `nodeId` and its subtree -- the fresh single-root selection
 *  used by BOTH entry paths: Cmd+A rung 2, and the first Shift+arrow press from a
 *  focused bullet. Entering deliberately selects just the node under the caret
 *  (never extends to a sibling or climbs to the parent); extension/depth-walk is
 *  for subsequent presses via {@link extendSelection}. */
export function selectSingle(nodeId: string) {
  selectionActor.send({ type: "select.single", nodeId });
}

/** Move the focus end one visible sibling in `direction` (Shift+arrow), once a
 *  selection exists. A no-op while idle (the `idle` state has no `extend`). */
export function extendSelection(direction: "up" | "down") {
  selectionActor.send({ type: "extend", direction });
}

/** Select every visible top-level child of the current view (Cmd+A rung 3). */
export function selectAllInView() {
  selectionActor.send({ type: "select.all" });
}

/** Whether the current selection already covers the whole current view -- the
 *  top rung of the Cmd+A ladder, so a further Cmd+A is bounded (a no-op). */
export function isWholeViewSelected(): boolean {
  const s = snapshot().context.data;
  if (!s) return false;
  const rootId = getViewRootId();
  if (s.parentId !== rootId) return false;
  const sibs = visibleSiblings(getTreeIndex(), rootId);
  return (
    sibs.length > 0 &&
    s.rootIds.length === sibs.length &&
    s.rootIds[0] === sibs[0]!.id &&
    s.rootIds[s.rootIds.length - 1] === sibs[sibs.length - 1]!.id
  );
}

/** Re-derive the selection from the LIVE collection, keeping the same
 *  anchor/focus. Call after a structural mutation that relocates the selected run
 *  (indent/outdent) so the next Shift+arrow or indent reads the run's NEW
 *  parent. Correct synchronously inside the same `runStructural` batch. */
export function refreshSelection() {
  selectionActor.send({ type: "refresh" });
}

/** Clear the selection (Escape, a click, a focus, after an op). No-op while idle
 *  -- guarding here keeps the hot focus/mousedown path (which calls this on every
 *  click to enforce caret/selection exclusivity) from notifying every selection
 *  subscriber when there's nothing to clear (an unhandled `clear` in `idle` still
 *  emits a snapshot in xstate v6), matching the pre-XState `if (!state) return`. */
export function clearSelection() {
  if (snapshot().value !== "selecting") return;
  selectionActor.send({ type: "clear" });
}

/**
 * Per-node subscription to this node's slab edge: a row re-renders only when ITS
 * edge changes (entering/leaving the selection or shifting top<->middle<->bottom),
 * never on an unrelated selection change. `useSelector` runs the selector on every
 * snapshot but only re-renders when the returned edge value differs (`Object.is`),
 * which is what keeps multi-selection inside ADR 0014's per-node-render budget.
 * Returns null when the node isn't a selected root.
 */
export function useSelectionEdge(id: string): SelectionEdge | null {
  return useSelector(
    selectionActor,
    (snap) => edgeOf(id, snap.context.data),
    Object.is,
  );
}

/** Reactive `rootIds` for the actions menu. `useSelector` re-renders only when the
 *  array value changes (`Object.is`); the context `rootIds` reference is stable
 *  across no-op transitions, so this never churns on an unrelated event. */
export function useSelectionRootIds(): string[] {
  return useSelector(
    selectionActor,
    (snap) =>
      (snap.context.data?.rootIds as string[] | undefined) ?? EMPTY_ROOTS,
    Object.is,
  );
}

/** Reactive "is a node selection active". Re-renders only on the idle<->selecting
 *  flip, not on every selection change within `selecting`. */
export function useIsSelectionActive(): boolean {
  return useSelector(selectionActor, (snap) => snap.value === "selecting");
}

/** Raw subscribe to any selection change, outside React. The one consumer is
 *  {@link "./selection-fill"}'s module-singleton mirror (ADR 0019's windowed
 *  list has no DOM nesting for a root's tint to paint behind its descendants,
 *  so the fill map needs its own walk -- this is how it learns a selection
 *  changed without itself being a React subscriber). Not part of the frozen
 *  consumer-facing API (selectSingle/extendSelection/useSelectionEdge/...) --
 *  an internal seam for the one other module in this slice. */
export function subscribeSelection(cb: () => void): () => void {
  const sub = selectionActor.subscribe(cb);
  return () => sub.unsubscribe();
}
