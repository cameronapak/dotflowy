import type { Node } from "./schema";

import { bibleRefsToMarkdownLinks } from "../plugins/route-bible/bible";
import { paragraphRoundTrips } from "./markdown-import";
import { linkTargetId, NODE_LINK_PATTERN } from "./node-links";
import { numberedOrdinals } from "./numbering";
import { childrenOf, trueSourceOf, type TreeIndex } from "./tree";

/** Two spaces per depth level (CommonMark-friendly, readable). */
const INDENT = "  ";

/**
 * The line prefix: an ordinal for numbered nodes, a GFM checkbox for tasks,
 * nothing for paragraphs, otherwise a plain bullet.
 *
 * A paragraph emits markdown's own paragraph syntax -- a bare line -- but ONLY
 * when that line reads back as the same paragraph (ADR 0044's amendment).
 * `- foo`, `# foo`, an empty paragraph, and anything the block grammar would
 * consume fall back to the `- ` prefix: every character kept, kind degrades to
 * bullet, idempotent. `text` is the line as it will actually be emitted (post
 * bible-ref projection), not `node.text` -- the guard has to see what the parser
 * will see. Kind outranks `isTask` here as it does in the renderer.
 */
function prefixFor(
  node: Node,
  text: string,
  ordinal: number | undefined,
): string {
  if (node.kind === "embed") return "- ";
  if (node.kind === "paragraph") return paragraphRoundTrips(text) ? "" : "- ";
  if (node.kind === "numbered") return `${ordinal ?? 1}. `;
  if (node.isTask) return node.completed ? "- [x] " : "- [ ] ";
  return "- ";
}

/** Resolve inline pointers, not subtrees. Keep markdown formatting and URLs;
 *  a path-local guard terminates cycles without suppressing repeated links. */
function resolveNodeLinks(
  index: TreeIndex,
  text: string,
  path: Set<string>,
): string {
  return text.replace(new RegExp(NODE_LINK_PATTERN, "g"), (token) => {
    const id = trueSourceOf(index, linkTargetId(token));
    const target = index.byId.get(id);
    if (!target) return "missing link";
    if (path.has(id)) return "…";
    path.add(id);
    const label = resolveNodeLinks(index, target.text, path);
    path.delete(id);
    return label;
  });
}

function emit(
  index: TreeIndex,
  id: string,
  depth: number,
  lines: string[],
  path: Set<string>,
  ordinalsFor: (parentId: string | null) => Map<string, number>,
): void {
  const node = index.byId.get(id);
  if (!node) return;
  // A mirror windows its SOURCE (ADR 0022), so the content -- text, task state,
  // and the whole subtree -- is read from `mirrorOf`. Markdown cannot carry
  // mirror-ness, and dropping the content is not an option: a mirror flattens to
  // an independent copy (ADR 0044, round-trip exception 3). Without this resolve
  // the exporter emits an empty childless bullet for every mirror, silently
  // losing the windowed content from every copy. A broken mirror (source gone)
  // falls back to its own stored snapshot text.
  const content = index.byId.get(trueSourceOf(index, id)) ?? node;
  // `content.text` is mostly already the markdown source (links `[label](url)`,
  // `#tags`, inline `code`). Node links become their current target text, and
  // Bible references become portable markdown links. Empty text yields a bare
  // `- ` bullet, preserving structure. See ADR 0017.
  const text = bibleRefsToMarkdownLinks(
    resolveNodeLinks(index, content.text, new Set([content.id])),
  );
  const ordinal =
    content.kind === "numbered"
      ? ordinalsFor(node.parentId).get(id)
      : undefined;
  lines.push(INDENT.repeat(depth) + prefixFor(content, text, ordinal) + text);
  // A mirror nested inside its own source's subtree would recurse forever: its
  // text is emitted once (above) and the walk does not descend. `path` is the
  // ANCESTOR chain, not a global seen-set -- one source mirrored into two
  // branches must expand fully in both.
  if (path.has(content.id)) return;
  path.add(content.id);
  // Full subtree, regardless of collapsed/completed/filter: childrenOf returns
  // the raw ordered children (view state never reaches here).
  for (const child of childrenOf(index, content.id)) {
    emit(index, child.id, depth + 1, lines, path, ordinalsFor);
  }
  path.delete(content.id);
}

/**
 * Serialize one or more subtrees to a nested markdown list. Each id in `rootIds`
 * becomes a top-level line; its full subtree is emitted beneath it, indented two
 * spaces per level. Never headings, so depth never changes a node's syntax: a
 * bullet is `- `, a task `- [ ] `, a numbered item `N. `, a paragraph a bare line.
 * See ADR 0045. Pure and
 * view-agnostic -- its only inputs are the index and the roots. See ADR 0017.
 *
 * The inverse is `markdown-import.ts`; the pair is held to
 * `parse(outlineToMarkdown(t)) === t` (ADR 0044) with documented portability
 * exceptions, including mirror expansion and node links becoming target text.
 */
export function outlineToMarkdown(index: TreeIndex, rootIds: string[]): string {
  const lines: string[] = [];
  // Cache full sibling sequences, not selected roots: copying item 3 alone
  // still emits `3.`, including when preceding siblings are completed/hidden.
  const byParent = new Map<string | null, Map<string, number>>();
  const ordinalsFor = (parentId: string | null): Map<string, number> => {
    let ordinals = byParent.get(parentId);
    if (!ordinals) {
      ordinals = numberedOrdinals(
        index,
        childrenOf(index, parentId).map((node) => node.id),
      );
      byParent.set(parentId, ordinals);
    }
    return ordinals;
  };
  for (const id of rootIds) emit(index, id, 0, lines, new Set(), ordinalsFor);
  return lines.join("\n");
}
