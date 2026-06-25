// Pure link layer for rich links (ADR 0017). A link is `[label](url)` living
// literally in `node.text` -- never a stored field, exactly like a `code` run
// or a `#tag`. The links plugin (src/plugins/links, ADR 0018) reuses
// LINK_PATTERN to decorate the same runs as a token; while a bullet is focused
// they show as raw markdown, while blurred they fold to a clean <a>.
//
// This module is DOM-free and side-effect-free. The DOM half (folding,
// caret remap on reveal) lives in inline-code.ts; the link-aware paste cases in
// the links plugin, over the core paste handler in paste.ts.

// A link token: `[label](url)`. The label is "anything but `]`", the url is
// "anything but `)`". Kept deliberately simple -- URLs that would break it (a
// literal `)`, `(`, or space) are percent-encoded by encodeUrlForMarkdown when
// WE insert a link, so every machine-made link parses. A hand-typed URL with a
// raw `)` is the accepted rough edge (ADR 0017).
export const LINK_PATTERN = "\\[[^\\]]*\\]\\([^)]*\\)";

const LINK_RE = () => new RegExp(`\\[([^\\]]*)\\]\\(([^)]*)\\)`, "g");

/** True iff the text contains at least one complete link token. */
export function hasLink(text: string): boolean {
  return new RegExp(LINK_PATTERN).test(text);
}

/** A single parsed link occurrence. `start`/`end` index into the source text. */
interface ParsedLink {
  label: string;
  url: string;
  start: number;
  end: number;
}

/** Every link in the text, in document order. */
function parseLinks(text: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  for (const m of text.matchAll(LINK_RE())) {
    out.push({
      label: m[1] ?? "",
      url: m[2] ?? "",
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

/** Flatten links to their label text -- the projection used for fuzzy search
 *  and for clean display in result rows (ADR 0017). */
export function stripLinks(text: string): string {
  return text.replace(LINK_RE(), (_full, label: string) => label);
}

/** http(s) only -- the single URL shape v1 auto-detects (ADR 0017). */
export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** If `s` is exactly one bare http(s) URL (no surrounding whitespace/words),
 *  return it trimmed; otherwise null. Used by paste (wrap a selection, or
 *  auto-link a pasted URL). */
export function bareHttpUrl(s: string): string | null {
  const t = s.trim();
  if (!t || /\s/.test(t)) return null;
  return isHttpUrl(t) ? t : null;
}

/** Percent-encode the characters that would break the `(url)` half of the
 *  simple parser. The label keeps its pretty parens; only the url is encoded. */
export function encodeUrlForMarkdown(url: string): string {
  return url
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}
