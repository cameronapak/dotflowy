// Pure parser for multi-line markdown paste (Seam I extension). When the user
// pastes text containing newlines (e.g. a markdown list copied from Obsidian),
// we parse it into a flat list of {text, depth} items and the editor creates
// real sibling/child bullets via runStructural. This module is PURE -- no React,
// no collection, no DOM -- so it's unit-testable in isolation.
//
// Supported syntax (stripped from the text, not rendered as literal chars):
//   - unordered list:  "- text", "* text", "+ text"
//   - ordered list:    "1. text", "2. text", ...
//   - task list:       "- [ ] text", "- [x] text"
//   - nested via indentation: tabs or 2+ leading spaces per level
//   - plain text lines (no marker) become bullets at their indent depth
//
// The first line's text replaces the current selection (if any) and the rest
// become siblings/children of the focused bullet. Trailing empty lines are
// ignored; a lone empty line within the list creates an empty bullet.

/** One parsed item: the stripped text and its nesting depth (0 = top). */
export interface ParsedItem {
  text: string;
  /** Indentation depth, derived from leading tabs or 2-space groups. */
  depth: number;
  /** Whether this line was a markdown task ("[ ]" or "[x]"). */
  isTask: boolean;
  /** Whether the task was checked ("[x]"). Only meaningful when isTask. */
  completed: boolean;
}

// Matches a markdown list marker: "- ", "* ", "+ ", "N. ", or an empty
// marker at end-of-line ("-") -- common when copying a trailing blank bullet.
const LIST_MARKER = /^\s*(?:[-*+]|\d+\.)(?:\s+|$)/;

// Matches a task marker after a list marker: "[ ]" or "[x]" (case-insensitive).
const TASK_MARKER = /^\s*(?:[-*+]|\d+\.)\s+\[([xX ])\]\s+/;

/**
 * Parse multi-line clipboard text into a list of items. Returns null when the
 * input is single-line (no newline) or all-blank -- signaling "not a meaningful
 * multi-line paste, use the normal single-line path."
 *
 * Indentation rules (Obsidian-compatible):
 *   - tabs: each tab = 1 depth
 *   - spaces: every 2 leading spaces = 1 depth (1 space is flattened to 0)
 *   - mixed: tabs count first, then leftover spaces / 2
 */
export function parseMarkdownPaste(plain: string): ParsedItem[] | null {
  // Need at least one newline to be "multi-line paste."
  if (!plain.includes("\n")) return null;

  const lines = plain.replace(/\r\n/g, "\n").split("\n");
  // Strip a single trailing empty line (common from copy-with-trailing-newline).
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  // All-blank input (every line empty) is not a meaningful multi-line paste.
  if (lines.every((l) => l.trim() === "")) return null;

  const items: ParsedItem[] = [];

  for (const raw of lines) {
    // Measure leading indentation.
    let tabs = 0;
    let spaces = 0;
    for (const ch of raw) {
      if (ch === "\t") tabs++;
      else if (ch === " ") spaces++;
      else break;
    }
    const depth = tabs + Math.floor(spaces / 2);

    let rest = raw.slice(tabs + spaces);

    // Task marker check first (it subsumes the list marker).
    const taskMatch = TASK_MARKER.exec(rest);
    if (taskMatch) {
      const flag = taskMatch[1]!;
      items.push({
        text: rest.slice(taskMatch[0].length),
        depth,
        isTask: true,
        completed: flag !== " ",
      });
      continue;
    }

    // Plain list marker: strip it.
    const listMatch = LIST_MARKER.exec(rest);
    if (listMatch) {
      items.push({
        text: rest.slice(listMatch[0].length),
        depth,
        isTask: false,
        completed: false,
      });
      continue;
    }

    // Plain text line (could be a continuation, a heading, a paragraph, etc.).
    // Treat it as a bullet at its indent depth.
    items.push({ text: rest, depth, isTask: false, completed: false });
  }

  return items;
}

/**
 * Normalize depths so the first item is depth 0 and all depths are relative
 * (a paste indented from the start, e.g. all lines have 2 leading spaces, is
 * flattened). This prevents the first bullet from being a child of nothing.
 * Mutates the array in place for efficiency; returns it for chaining.
 */
export function normalizeDepths(items: ParsedItem[]): ParsedItem[] {
  if (items.length === 0) return items;
  const minDepth = Math.min(...items.map((i) => i.depth));
  if (minDepth > 0) {
    for (const item of items) item.depth -= minDepth;
  }
  // Clamp: no item can be deeper than prev.depth + 1 (skip levels).
  // This prevents orphan children if the source skipped an indent level.
  let maxAllowed = 0;
  for (const item of items) {
    maxAllowed = Math.min(item.depth, maxAllowed + 1);
    item.depth = maxAllowed;
  }
  return items;
}
