import { type TreeIndex } from "../../data/tree";
import { toggleCollapsed } from "../../data/mutations";

/**
 * On zoom-out, expand every collapsed ancestor on the path from `pivot` (the
 * node we're leaving) up to — but not including — `toRootId` (the destination
 * root, or null for Home). This makes the trail that led to `pivot` visible in
 * the view we're navigating to.
 *
 * No-op unless `pivot` is actually a descendant of `toRootId` — so zooming IN
 * (pivot === toRootId) and any non-ancestral jump leave collapse state alone.
 */
export function revealAncestorsToRoot(
  index: TreeIndex,
  pivot: string,
  toRootId: string | null,
) {
  if (pivot === toRootId) return;
  const collapsedOnPath: string[] = [];
  let current = index.byId.get(pivot)?.parentId ?? null;
  // Guard against corrupted parent chains, mirroring buildTrail.
  let guard = index.byId.size + 1;
  while (current && current !== toRootId && guard-- > 0) {
    const node = index.byId.get(current);
    if (!node) break;
    if (node.collapsed) collapsedOnPath.push(current);
    current = node.parentId ?? null;
  }
  // Only expand if we walked all the way up to the destination root; otherwise
  // pivot wasn't below it and we'd be mangling an unrelated branch.
  if (current !== toRootId) return;
  for (const id of collapsedOnPath) toggleCollapsed(id, false);
}
