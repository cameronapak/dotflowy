import type { Node } from './schema'
import { childrenOf, type TreeIndex } from './tree'
import { bibleRefsToMarkdownLinks } from '../plugins/route-bible/bible'

/** Two spaces per depth level (CommonMark-friendly, readable). */
const INDENT = '  '

/** The bullet marker for a node: a GFM task checkbox when it's a task, else a
 *  plain bullet. */
function prefixFor(node: Node): string {
  if (node.isTask) return node.completed ? '- [x] ' : '- [ ] '
  return '- '
}

function emit(
  index: TreeIndex,
  id: string,
  depth: number,
  lines: string[],
  path: Set<string>,
): void {
  const node = index.byId.get(id)
  if (!node) return
  // A mirror windows its SOURCE (ADR 0022), so the content -- text, task state,
  // and the whole subtree -- is read from `mirrorOf`. Markdown cannot carry
  // mirror-ness, and dropping the content is not an option: a mirror flattens to
  // an independent copy (ADR 0044, round-trip exception 3). Without this resolve
  // the exporter emits an empty childless bullet for every mirror, silently
  // losing the windowed content from every copy. A broken mirror (source gone)
  // falls back to its own stored snapshot text.
  const content = index.byId.get(node.mirrorOf ?? id) ?? node
  // `content.text` is mostly already the markdown source (links `[label](url)`,
  // `#tags`, inline `code`). Route-bible chips are the exception: they store
  // plain reference text and derive the URL at render time, so export projects
  // them to portable markdown links. Empty text yields a bare `- ` bullet,
  // preserving structure. See ADR 0017.
  lines.push(INDENT.repeat(depth) + prefixFor(content) + bibleRefsToMarkdownLinks(content.text))
  // A mirror nested inside its own source's subtree would recurse forever: its
  // text is emitted once (above) and the walk does not descend. `path` is the
  // ANCESTOR chain, not a global seen-set -- one source mirrored into two
  // branches must expand fully in both.
  if (path.has(content.id)) return
  path.add(content.id)
  // Full subtree, regardless of collapsed/completed/filter: childrenOf returns
  // the raw ordered children (view state never reaches here).
  for (const child of childrenOf(index, content.id)) {
    emit(index, child.id, depth + 1, lines, path)
  }
  path.delete(content.id)
}

/**
 * Serialize one or more subtrees to a nested markdown bullet list. Each id in
 * `rootIds` becomes a top-level bullet; its full subtree is emitted beneath it,
 * indented two spaces per level. Uniform bullets (never headings) so every node
 * serializes identically and task roots survive as `- [ ]`. Pure and
 * view-agnostic -- its only inputs are the index and the roots. See ADR 0017.
 *
 * The inverse is `markdown-import.ts`; the pair is held to
 * `parse(outlineToMarkdown(t)) === t` (ADR 0044) with three documented
 * exceptions, one of which is the mirror flattening `emit` performs above.
 */
export function outlineToMarkdown(index: TreeIndex, rootIds: string[]): string {
  const lines: string[] = []
  for (const id of rootIds) emit(index, id, 0, lines, new Set())
  return lines.join('\n')
}
