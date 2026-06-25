import { childrenOf, type Node, type TreeIndex } from "./tree";

type WalkVisibleOptions = {
  /** Skip this node and its subtree (drag excludes the grabbed bullet). */
  skip?: (node: Node) => boolean;
};

/**
 * Walk visible nodes in display order under `parentId`. Mirrors render visibility:
 * hidden nodes (the composed Seam-G prune) and their subtrees are absent.
 */
export function walkVisibleNodes(
  index: TreeIndex,
  parentId: string | null,
  isHidden: (node: Node) => boolean,
  onNode: (node: Node, depth: number) => void,
  depth = 0,
  options: WalkVisibleOptions = {},
): void {
  for (const child of childrenOf(index, parentId)) {
    if (isHidden(child)) continue;
    if (options.skip?.(child)) continue;
    onNode(child, depth);
    if (!child.collapsed) {
      walkVisibleNodes(index, child.id, isHidden, onNode, depth + 1, options);
    }
  }
}

/** Flat list of visible node ids in display order within the current zoom root. */
function flattenVisible(
  index: TreeIndex,
  rootId: string | null,
  isHidden: (node: Node) => boolean,
): Array<{ id: string }> {
  const out: Array<{ id: string }> = [];
  // The zoomed title participates in up/down navigation.
  if (rootId) out.push({ id: rootId });
  walkVisibleNodes(index, rootId, isHidden, (node) => {
    out.push({ id: node.id });
  });
  return out;
}

/**
 * Walk the visible outline in display order and return the id of the node
 * immediately before/after `id`, or null if none. The zoom root (the title) is
 * the first entry, so ArrowUp from the first child lands on the title.
 */
export function findVisibleNeighbor(
  index: TreeIndex,
  rootId: string | null,
  id: string,
  direction: "up" | "down",
  isHidden: (node: Node) => boolean,
): string | null {
  const flat = flattenVisible(index, rootId, isHidden);
  const i = flat.findIndex((n) => n.id === id);
  if (i === -1) return null;
  const neighbor = direction === "up" ? flat[i - 1] : flat[i + 1];
  return neighbor ? neighbor.id : null;
}
