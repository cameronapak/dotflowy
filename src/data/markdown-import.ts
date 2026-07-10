// Markdown paste core (ADR 0044): markdown source -> intermediate forest ->
// a landing plan. The INVERSE of `markdown.ts`'s `outlineToMarkdown`, and its
// sibling: the design is anchored on `parse(outlineToMarkdown(t)) === t`, not
// on "import anything". Pure, DOM-free, `bun test`-able — the `opml-import.ts`
// shape, one direction over.
//
// The fidelity bar (a paste has no confirm step, so it can't borrow OPML's
// "count the degradations and disclose them"):
//
//   Never drop a character of content. Freely drop syntax dotflowy cannot
//   represent -- but only when the result is idempotent.
//
// Idempotent = parse it, serialize it with `outlineToMarkdown`, parse again,
// and you are at a fixed point. That is why the fence delimiters survive as
// bullets, why a blockquote keeps its text, and why marker stripping never
// recurses.
//
// NOT remark/micromark/marked: a CommonMark library yields an AST of paragraphs
// and inline nodes which we would then have to RE-SERIALIZE back to markdown to
// obtain `node.text` -- parse-then-unparse, landing where the raw string already
// was, having lost byte-exactness on the way. We need block structure and
// nothing else. See ADR 0044; do not add a markdown dependency here.

import { OPML_APP_MAX_NODES } from "./opml-import";
import { childrenOf, type TreeIndex } from "./tree";

/** The paste ceiling, shared with the OPML app import (ADR 0044: one number,
 *  one place). Over it, the paste is rejected outright -- nothing inserted. */
export const PASTE_MAX_NODES = OPML_APP_MAX_NODES;

/** Raw-input guard, applied BEFORE parsing so a hostile clipboard never reaches
 *  the line scan. `DEFAULT_MAX_OPML_LENGTH`'s shape at paste scale: 50,000
 *  bullets of 200 characters is 10 MB, so this bounds the scan without ever
 *  being the limit a real paste meets (the node ceiling is). */
export const PASTE_MAX_LENGTH = 10 * 1024 * 1024;

/** One parsed line, pre id-minting. `text` is markdown source verbatim --
 *  `node.text` IS markdown, so inline constructs pass through untouched. */
export interface MdNode {
  text: string;
  isTask: boolean;
  completed: boolean;
  children: MdNode[];
}

// --- The grammar --------------------------------------------------------------

/** `#{1,6}` + at least one space. The space is LOAD-BEARING: `#urgent` is a tag
 *  (`TAG_PATTERN` is `#` immediately followed by a word char) and `# urgent` is
 *  a heading. The two are exactly disjoint; "trim the leading #s" silently eats
 *  the tags feature. Seven hashes never match, so `####### x` stays literal. */
const HEADING_RE = /^(#{1,6}) +(.*)$/;

/** One list marker: `-` `*` `+` or an ordinal `1.` / `1)`. The trailing
 *  `[ \t]|$` is what keeps `*bold*` from looking like a bullet, and what lets a
 *  bare `-` (an empty node -- `outlineToMarkdown` emits `- ` for empty text,
 *  which editors and `.trim()` eat) be recognized.
 *
 *  EXACTLY ONE separator character is consumed, not the `\s+` a lenient markdown
 *  reader takes. `outlineToMarkdown` emits one space after the marker, so a
 *  second space is CONTENT -- and eating it flattens the indentation of every
 *  fence interior on re-import, which the fidelity bar forbids and the fence rule
 *  promises to keep. The price is that foreign markdown which pads its marker
 *  (`-   item`) imports with the padding as leading text: visible, and one
 *  keystroke to delete, where dropped indentation is silent and unrecoverable.
 *  This parser is `outlineToMarkdown`'s inverse before it is anyone's importer.
 *  See ADR 0044. */
const LIST_MARKER_RE = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** A run of blockquote markers at the very start of the content. Stripping the
 *  whole run keeps every character and is a fixed point (no `>` survives). */
const BLOCKQUOTE_RE = /^(?:>[ \t]*)+/;

/** A GFM task checkbox, only ever matched AFTER a list marker was consumed
 *  (GFM requires the list item). `- [ ]` with no text is an empty task. One
 *  separator character, for `LIST_MARKER_RE`'s reason: `outlineToMarkdown` emits
 *  `- [x] `, so `- [x]   x` carries the text `  x`. */
const TASK_RE = /^\[([ xX])\](?:[ \t]|$)/;

/** An opening or closing code fence: three or more backticks or tildes at the
 *  start of the content, capturing the info string after them. Checked BEFORE
 *  marker stripping -- that is exactly why a re-pasted fence delimiter
 *  (serialized as ``- ```ts``) never re-fires. */
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;

/** Visual column width of a line's leading whitespace; a tab advances to the
 *  next multiple of 4. Only the relative order of these widths matters -- the
 *  indent stack turns them into depths, so 2-space, 4-space, and tab documents
 *  all nest identically. */
function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === "\t") width += 4 - (width % 4);
    else if (ch === " ") width += 1;
    else break;
  }
  return width;
}

function leaf(text: string, isTask = false, completed = false): MdNode {
  return { text, isTask, completed, children: [] };
}

/**
 * Markdown source -> a forest of `MdNode`.
 *
 * Two rules a reader will want up front, both deliberate divergences:
 *
 *  - **One line, one bullet.** CommonMark joins consecutive non-blank lines into
 *    a paragraph; we do not. Honoring paragraph continuation reads nicely on
 *    hard-wrapped prose and then fuses a pasted poem, name list, or stack trace
 *    into a single bullet. The outliner's atomic unit is the line.
 *  - **Headings drive nesting.** `## Background` is a CHILD of the preceding
 *    `# Intro`; body and lists under a heading nest beneath it. A document's
 *    heading hierarchy IS an outline in another notation, and flattening it to
 *    sibling bullets destroys the containment the user came to an outliner for.
 *    Heading depth sets a floor; list indentation nests inside that floor.
 *
 * `literal` (the `Mod+Shift+V` hatch) skips the grammar entirely: every line
 * becomes one top-level bullet, verbatim. No marker stripping, no depth.
 */
export function parseMarkdownForest(
  source: string,
  options: { literal?: boolean } = {},
): MdNode[] {
  // One trailing newline is a line terminator, not an empty last line -- so a
  // copied "https://x.com\n" stays a SINGLE-line paste and keeps the links
  // plugin's URL wrap + unfurl (Seam I).
  const normalized = source.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const lines = normalized.split("\n");

  const roots: MdNode[] = [];
  // stack[d] is the currently-open node at depth d; its children receive the
  // next node at depth d+1. Depth is CLAMPED to stack.length, which is how a
  // skipped indent level (0 spaces -> 8 spaces) lands one level down, not four.
  const stack: MdNode[] = [];
  const push = (depth: number, node: MdNode): number => {
    const d = Math.min(depth, stack.length);
    stack.length = d;
    if (d === 0) roots.push(node);
    else stack[d - 1]!.children.push(node);
    stack.push(node);
    return d;
  };

  if (options.literal) {
    for (const line of lines) push(0, leaf(line));
    return roots;
  }

  // Open heading levels, outermost first. A heading's depth is this stack's
  // length BEFORE it is pushed, so a document whose shallowest heading is `###`
  // normalizes to depth 0, and `# A` followed by `### C` clamps C to depth 1.
  const headings: number[] = [];
  // Distinct indent widths on the current list ladder, ascending.
  let indents: number[] = [];
  // Inside a fence: the delimiter's own char/length and the depth every line of
  // the raw block (interior AND both delimiters) lands at.
  let fence: { char: string; len: number; depth: number } | null = null;

  for (const line of lines) {
    const width = indentWidth(line);
    const content = line.trimStart();

    if (fence) {
      // Raw mode: no marker stripping, no depth inference, leading whitespace
      // preserved (`.node-text` is `white-space: pre-wrap`, and leading
      // whitespace is content in code). A blank line inside a fence is content
      // too, so it becomes an empty bullet rather than being dropped.
      push(fence.depth, leaf(line));
      const close = FENCE_RE.exec(content);
      if (
        close &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.len &&
        close[2]!.trim() === "" // a closing fence carries no info string
      ) {
        fence = null;
      }
      continue;
    }

    // A code block cannot exist in dotflowy (`node.text` is one line), so we do
    // not map one -- the fence SUPPRESSES the grammar instead, and both
    // delimiter lines survive as bullets. Nothing is dropped; the user deletes
    // them. Detected before marker stripping, so the re-pasted ``- ```ts``
    // no longer starts with a backtick and the fence never re-fires: one pass,
    // then a fixed point.
    const open = FENCE_RE.exec(content);
    if (open) {
      const depth = pushListLine(line, width, content, headings, indents, push);
      fence = { char: open[1]![0]!, len: open[1]!.length, depth };
      continue;
    }

    if (content === "") continue; // blank lines are separators, not content

    const heading = HEADING_RE.exec(content);
    if (heading) {
      const level = heading[1]!.length;
      while (headings.length && headings[headings.length - 1]! >= level)
        headings.pop();
      push(headings.length, leaf(heading[2]!));
      headings.push(level);
      indents = []; // list indentation restarts inside each heading's floor
      continue;
    }

    pushListLine(line, width, content, headings, indents, push);
  }

  return roots;
}

/** Emit one non-heading, non-fenced line at `headingFloor + listDepth`, keeping
 *  the indent ladder in sync. Split out only because the fence-open line needs
 *  the depth it lands at. Mutates `indents` in place. */
function pushListLine(
  line: string,
  width: number,
  content: string,
  headings: readonly number[],
  indents: number[],
  push: (depth: number, node: MdNode) => number,
): number {
  while (indents.length && indents[indents.length - 1]! > width) indents.pop();
  if (!indents.length || indents[indents.length - 1]! < width)
    indents.push(width);
  const depth = headings.length + indents.length - 1;

  // A fence-open line is raw: its own text, not a stripped one.
  const fenceOpen = FENCE_RE.test(content);
  return push(depth, fenceOpen ? leaf(line) : leaf(...stripLine(content)));
}

/**
 * Strip block syntax from one line's content, exactly once each and in this
 * order: blockquote run, then EITHER a heading (handled by the caller) or one
 * list marker, then a task checkbox.
 *
 * Stripping never recurses. A node whose text is literally `- foo` exports as
 * `- - foo`; one strip yields `- foo`, which is correct. Recurse and the
 * content is gone. Likewise `- # foo` keeps the text `# foo` -- the heading
 * grammar only fires at the start of a line's content, before any marker.
 */
function stripLine(content: string): [string, boolean, boolean] {
  const quoted = content.replace(BLOCKQUOTE_RE, "");
  const marker = LIST_MARKER_RE.exec(quoted);
  if (!marker) return [quoted, false, false];
  const rest = quoted.slice(marker[0].length);
  const task = TASK_RE.exec(rest);
  if (!task) return [rest, false, false];
  return [rest.slice(task[0].length), true, task[1]!.toLowerCase() === "x"];
}

/** Total nodes in the forest -- what the ceiling counts. */
export function countForest(forest: readonly MdNode[]): number {
  let n = 0;
  const stack = [...forest];
  while (stack.length) {
    const node = stack.pop()!;
    n++;
    for (const child of node.children) stack.push(child);
  }
  return n;
}

// --- Forest + caret -> a landing plan ---------------------------------------

/** Where the remaining pasted roots go. A list bullet takes them as SIBLINGS;
 *  the zoomed page title cannot (its siblings live outside the view, so
 *  inserting one makes it vanish), so they become its prepended CHILDREN. */
export type MdPastePlacement = "sibling" | "child-prepend";

export interface MdPasteInsert {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
}

export interface MdPastePlan {
  /** Fields to write onto the node the caret was in. */
  anchor: { text: string; isTask: boolean | null; completed: boolean | null };
  /** New nodes, depth-first pre-order, sibling chain wired by construction. */
  inserts: MdPasteInsert[];
  /** Existing nodes whose `prevSiblingId` now points at a pasted node. */
  repoints: Array<{ id: string; prevSiblingId: string }>;
  /** The node holding the caret afterwards, and the source offset within it --
   *  the seam where `tail` welded back on. */
  focusId: string;
  focusOffset: number;
  /** Bullets the paste creates, anchor excluded. */
  insertCount: number;
}

/**
 * Plan where a pasted forest lands, given the caret.
 *
 * The specification is one sentence: **a paste behaves exactly as if the user
 * typed the markdown by hand** -- Enter at each newline, Tab/Shift+Tab to reach
 * each depth. This function is the plan, never a keystroke replay. Everything
 * falls out of it:
 *
 *  1. The selection is already deleted (`head`/`tail` are what surround the
 *     collapsed caret, in SOURCE space).
 *  2. The anchor absorbs the first pasted line: `head + firstLine`. It inherits
 *     `isTask`/`completed` only when `head` is empty AND the line carries a task
 *     marker -- a paste mid-sentence must not flip a bullet into a task, and a
 *     plain line must not un-task the bullet it lands in.
 *  3. The anchor is the depth anchor: pasted children of line 1 become its
 *     children (before its existing ones); a second pasted root becomes its next
 *     sibling.
 *  4. `tail` appends to the LAST inserted node's text, however deep, and the
 *     caret lands at that seam. Surprising, and exactly what typing does; every
 *     alternative invents a special case the spec does not sanction. It almost
 *     never fires -- real pastes land at end-of-line or in an empty bullet.
 *
 * Pure: reads `index`, mints ids through `newId`. Returns null when the forest
 * is empty (an all-blank paste), which the caller treats as a plain-text paste.
 */
export function planMarkdownPaste(args: {
  index: TreeIndex;
  anchorId: string;
  placement: MdPastePlacement;
  forest: readonly MdNode[];
  head: string;
  tail: string;
  newId: () => string;
}): MdPastePlan | null {
  const { index, anchorId, placement, forest, head, tail, newId } = args;
  const anchor = index.byId.get(anchorId);
  const first = forest[0];
  if (!anchor || !first) return null;

  const inserts: MdPasteInsert[] = [];
  const repoints: MdPastePlan["repoints"] = [];

  // Depth-first pre-order emission: every chunked-frame prefix stays chain-valid
  // for live remote viewers (ADR 0037's lesson), and each node's prevSiblingId is
  // the previously-emitted sibling AT ITS LEVEL. Returns the emitted root ids.
  const emit = (
    siblings: readonly MdNode[],
    parentId: string | null,
    initialPrev: string | null,
  ): string[] => {
    const ids: string[] = [];
    let prev = initialPrev;
    for (const node of siblings) {
      const id = newId();
      inserts.push({
        id,
        parentId,
        prevSiblingId: prev,
        text: node.text,
        isTask: node.isTask,
        completed: node.completed,
      });
      ids.push(id);
      if (node.children.length) emit(node.children, id, null);
      prev = id;
    }
    return ids;
  };

  const rest = forest.slice(1);
  // The title takes every remaining root as a child; a bullet splits them into
  // "children of line 1" and "siblings of the anchor".
  const asChildren =
    placement === "child-prepend"
      ? [...first.children, ...rest]
      : first.children;
  const asSiblings = placement === "child-prepend" ? [] : rest;

  const existingFirstChild = childrenOf(index, anchorId)[0] ?? null;
  const childIds = emit(asChildren, anchorId, null);
  if (childIds.length && existingFirstChild) {
    repoints.push({
      id: existingFirstChild.id,
      prevSiblingId: childIds[childIds.length - 1]!,
    });
  }

  const siblings = childrenOf(index, anchor.parentId);
  const anchorAt = siblings.findIndex((n) => n.id === anchorId);
  const existingNext =
    anchorAt !== -1 ? (siblings[anchorAt + 1] ?? null) : null;
  const siblingIds = emit(asSiblings, anchor.parentId, anchorId);
  if (siblingIds.length && existingNext) {
    repoints.push({
      id: existingNext.id,
      prevSiblingId: siblingIds[siblingIds.length - 1]!,
    });
  }

  // The last node in DOCUMENT order. Pre-order emission (children group, then
  // sibling group; each root then its subtree) means the final insert is always
  // the last root's rightmost-deepest descendant. Nothing emitted -> the anchor
  // itself is the seam, which is the single-root, childless paste.
  const last = inserts[inserts.length - 1] ?? null;

  const anchorText = head + first.text + (last === null ? tail : "");
  if (last !== null) last.text += tail;

  return {
    anchor: {
      text: anchorText,
      // Only a task MARKER on the absorbed line converts the anchor, and only
      // when it truly leads the bullet. A plain line never un-tasks.
      isTask: head === "" && first.isTask ? true : null,
      completed: head === "" && first.isTask ? first.completed : null,
    },
    inserts,
    repoints,
    focusId: last?.id ?? anchorId,
    focusOffset: (last ? last.text : anchorText).length - tail.length,
    insertCount: inserts.length,
  };
}
