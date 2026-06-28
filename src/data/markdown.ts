import type { Node } from './schema'
import { childrenOf, type TreeIndex } from './tree'

/** Two spaces per depth level (CommonMark-friendly, readable). */
const INDENT = '  '

/** The bullet marker for a node: a GFM task checkbox when it's a task, else a
 *  plain bullet. */
function prefixFor(node: Node): string {
  if (node.isTask) return node.completed ? '- [x] ' : '- [ ] '
  return '- '
}

function emit(index: TreeIndex, id: string, depth: number, lines: string[]): void {
  const node = index.byId.get(id)
  if (!node) return
  // `node.text` is already the markdown source (links `[label](url)`, `#tags`,
  // inline `code`) -- emit it verbatim, no transform. Empty text yields a bare
  // `- ` bullet, preserving structure. See ADR 0017.
  lines.push(INDENT.repeat(depth) + prefixFor(node) + node.text)
  // Full subtree, regardless of collapsed/completed/filter: childrenOf returns
  // the raw ordered children (view state never reaches here).
  for (const child of childrenOf(index, id)) {
    emit(index, child.id, depth + 1, lines)
  }
}

/**
 * Serialize one or more subtrees to a nested markdown bullet list. Each id in
 * `rootIds` becomes a top-level bullet; its full subtree is emitted beneath it,
 * indented two spaces per level. Uniform bullets (never headings) so every node
 * serializes identically and task roots survive as `- [ ]`. Pure and
 * view-agnostic -- its only inputs are the index and the roots. See ADR 0017.
 */
export function outlineToMarkdown(index: TreeIndex, rootIds: string[]): string {
  const lines: string[] = []
  for (const id of rootIds) emit(index, id, 0, lines)
  return lines.join('\n')
}
