import type { IFuseOptions } from "fuse.js";

import type { PluginDef } from "../plugins/types";

import { childrenOf, type Node, type TreeIndex } from "../data/tree";

/**
 * Shared Fuse config for the node-destination pickers (`/move` + quick-add's
 * retarget chip), so the two can't rank the same query differently. Plugin
 * search aliases (Seam J) ride along, so "today" finds the daily note despite
 * its full-date text. `includeMatches` is deliberately OMITTED here -- a caller
 * that highlights matches (the move dialog) spreads it on top; a caller that
 * doesn't (quick-add) skips the per-keystroke match-range allocation.
 */
export function targetSearchOptions(
  aliasProviders: readonly NonNullable<PluginDef["searchAliases"]>[],
): IFuseOptions<Node> {
  return {
    keys: [
      "text",
      {
        name: "aliases",
        getFn: (node) => aliasProviders.flatMap((provider) => provider(node)),
      },
    ],
    ignoreLocation: true,
    threshold: 0.3,
    minMatchCharLength: 2,
  };
}

/** A node plus every descendant -- the set a node can't be moved into. */
export function subtreeIds(index: TreeIndex, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const child of childrenOf(index, id)) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return ids;
}

/** Every node eligible as a destination: excludes `excludeIds` (a moved node +
 *  its subtree, or the draft being retargeted) and blank nodes. Shared by both
 *  pickers so their candidate sets match. */
export function buildTargetCandidates(
  index: TreeIndex,
  excludeIds: Set<string>,
): Node[] {
  return Array.from(index.byId.values()).filter(
    (n) => !excludeIds.has(n.id) && n.text.trim() !== "",
  );
}
