/**
 * The inline markdown a changelog entry is allowed to speak (ADR 0046).
 *
 * Fragments are hand-authored markdown, and they always were — `CHANGELOG.md`
 * and the GitHub Release body render them as such. Only the in-app dialog was
 * printing the source, so `**Relearn one gesture:**` reached the reader with its
 * asterisks on. This closes that gap WITHOUT touching the stored text: the
 * fragment stays the source of truth, and the dialog just reads it properly.
 *
 * Deliberately NOT a markdown dependency, and deliberately NOT the plugin token
 * pipeline. The vocabulary here is what the archive actually uses — `**bold**`
 * and `` `code` `` — which is two regex alternatives, while `remark` is a
 * parser for a document format this text is not, and the Seam-A tokens are
 * built for a caret-aware contentEditable that folds and reveals as you type
 * (ADR 0025). Both are the wrong size for a paragraph in a dialog.
 *
 * Adding a form later means one alternative in the pattern and one arm in the
 * component. Add it when a fragment uses it, not before.
 */

/** Backtick before asterisk mirrors the editor's own precedence (code 10 <
 *  emphasis 30, ADR 0025): a code span shields its interior, so `` `**x**` ``
 *  keeps its asterisks.
 *
 *  Built per-call, never a module singleton: a `g`-flagged RegExp carries
 *  `lastIndex` across calls, so a shared instance would skip runs on a second
 *  pass (the `emphasis.ts` / `code.ts` rule). */
function inlineRegex(): RegExp {
  return /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
}

export type InlineSegment =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string };

/**
 * Split a summary into renderable segments, longest-run-first.
 *
 * Total by construction: everything the pattern doesn't claim comes back as
 * `text`, so an unmatched or half-typed marker (`**oops`) renders verbatim
 * rather than vanishing. Never returns HTML — the caller builds React nodes, so
 * there is no `dangerouslySetInnerHTML` anywhere on this path.
 */
export function parseInlineMarkdown(summary: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let cursor = 0;

  const pattern = inlineRegex();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(summary)) !== null) {
    if (match.index > cursor) {
      segments.push({
        kind: "text",
        value: summary.slice(cursor, match.index),
      });
    }
    const [, code, strong] = match;
    segments.push(
      code !== undefined
        ? { kind: "code", value: code }
        : { kind: "strong", value: strong! },
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < summary.length) {
    segments.push({ kind: "text", value: summary.slice(cursor) });
  }
  return segments;
}
