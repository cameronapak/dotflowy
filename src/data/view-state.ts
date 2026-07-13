import { useEffect } from "react";

import type { QueryFilter } from "./filter-query";
import type { Node } from "./tree";

/**
 * The editor's ephemeral *view* state (the zoom root and the composed
 * visibility prune), mirrored into a module singleton so the stable
 * command/drag/zoom closures can read the current value at EVENT time without
 * depending on this render -- exactly as {@link getTreeIndex} does for the tree
 * itself (tree-store.ts). Keeping these out of the closures' deps is what lets
 * `commands` keep its identity across renders, a prop on every memoized
 * OutlineRow (see docs/adr/0004-localized-rendering-via-the-tree-store.md).
 *
 * Two read paths for the same value:
 *  - **Render reads** use the React value directly (the `rootId` prop, the
 *    `isHidden` memo) so they stay reactive. Never read these getters in render.
 *  - **Event-time reads** (drag, command handlers, zoom, hotkeys -- all fire on
 *    pointer/key/click, after commit) go through {@link getViewRootId} /
 *    {@link getViewIsHidden}.
 *
 * Single mount of the editor backs the singleton, the same assumption
 * tree-store's single shared index relies on. Writes happen in an effect (NOT
 * during render), so nothing here trips the React Compiler's ref-during-render
 * bailout.
 */

let rootId: string | null = null;
let isHidden: (node: Node) => boolean = () => false;
let filter: QueryFilter | null = null;

/** The current zoom root, read live OUTSIDE render (event handlers, command
 *  closures, drag, hotkeys). Render reads must use the `rootId` prop instead so
 *  they stay reactive. */
export function getViewRootId(): string | null {
  return rootId;
}

/** The current composed visibility prune (Seam-G; hide-completed today), read
 *  live OUTSIDE render. Render reads must use the `isHidden` memo instead. */
export function getViewIsHidden(): (node: Node) => boolean {
  return isHidden;
}

/** The active `?q=` query filter's pruned set (ADR 0047), read live OUTSIDE render. Null
 *  when no filter is on. Its one event-time reader is the markdown paste, which
 *  must know whether what it just inserted actually landed on screen (ADR 0044:
 *  a paste never mutates view state, so it discloses instead). */
export function getViewFilter(): QueryFilter | null {
  return filter;
}

/**
 * Sync the live view mirror from the editor's render values. Call once in
 * OutlineEditor. The writes run in an effect -- after commit, so the mirror
 * always reflects the committed render at event time (identical to the old
 * render-written refs, since nothing reads these during render/layout) and
 * nothing here writes a ref during render.
 */
export function useSyncViewState(
  nextRootId: string | null,
  nextIsHidden: (node: Node) => boolean,
): void {
  useEffect(() => {
    rootId = nextRootId;
    isHidden = nextIsHidden;
  }, [nextRootId, nextIsHidden]);
}

/** The filter is derived further down the editor than `useSyncViewState`'s
 *  inputs (it needs `isHidden` first), so it mirrors on its own. */
export function useSyncViewFilter(nextFilter: QueryFilter | null): void {
  useEffect(() => {
    filter = nextFilter;
  }, [nextFilter]);
}
