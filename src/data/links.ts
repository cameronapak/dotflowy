// Pure link layer for rich links (ADR 0005). A link is `[label](url)` living
// literally in `node.text` -- never a stored field, exactly like a `code` run
// or a `#tag`. The links plugin (src/plugins/links, ADR 0001) reuses
// LINK_PATTERN to decorate the same runs as a token; while a bullet is focused
// they show as raw markdown, while blurred they fold to a clean <a>.
//
// This module is DOM-free and side-effect-free. The DOM half (folding,
// caret remap on reveal) lives in inline-code.ts; the link-aware paste cases in
// the links plugin, over the core paste handler in paste.ts.

import { spliceToken } from "../plugins/token-kit";

// A link token: `[label](url)`. The label is "anything but `]`", the url is
// "anything but `)`". Kept deliberately simple -- URLs that would break it (a
// literal `)`, `(`, or space) are percent-encoded by encodeUrlForMarkdown when
// WE insert a link, so every machine-made link parses. A hand-typed URL with a
// raw `)` is the accepted rough edge (ADR 0005).
export const LINK_PATTERN = "\\[[^\\]]*\\]\\([^)]*\\)";

const LINK_RE = () => new RegExp(`\\[([^\\]]*)\\]\\(([^)]*)\\)`, "g");

export interface LinkAtOffset {
  label: string;
  url: string;
  start: number;
  end: number;
}

/** True iff the text contains at least one complete link token. */
export function hasLink(text: string): boolean {
  return new RegExp(LINK_PATTERN).test(text);
}

/** Flatten links to their label text -- the projection used for fuzzy search
 *  and for clean display in result rows (ADR 0005). */
export function stripLinks(text: string): string {
  return text.replace(LINK_RE(), (_full, label: string) => label);
}

/** Return the markdown link whose source token contains or touches `offset`.
 *  The offset is in SOURCE space, matching contentEditable caret helpers. */
export function linkAtOffset(text: string, offset: number): LinkAtOffset | null {
  for (const m of text.matchAll(LINK_RE())) {
    const start = m.index ?? 0;
    const token = m[0] ?? "";
    const label = m[1] ?? "";
    const url = m[2] ?? "";
    const end = start + token.length;
    if (offset >= start && offset <= end) return { label, url, start, end };
  }
  return null;
}

export function linkUrlAtOffset(text: string, offset: number): string | null {
  return linkAtOffset(text, offset)?.url ?? null;
}

/** http(s) only -- the single URL shape v1 auto-detects (ADR 0005). */
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

// --- Title unfurl (ADR 0016) -----------------------------------------------
// A pasted bare URL inserts the placeholder `[url](url)`; a Worker fetches the
// page title and the label is swapped in async. These two pure helpers own the
// client half: make a fetched title safe to live in a `[label](url)` label, and
// perform the verbatim-match-or-drop swap. DOM-free, side-effect-free, tested.

/** Make a fetched page title safe to use as a link LABEL. The label grammar is
 *  `[^\]]*`, so a literal `]` is fatal -- it would close the label early and
 *  corrupt every token after it on the line. Strip `]`, collapse whitespace
 *  (titles arrive multi-line), and trim. May return "" -- the caller keeps the
 *  url placeholder when it does. */
export function sanitizeLinkLabel(title: string): string {
  return title.replace(/]/g, "").replace(/\s+/g, " ").trim();
}

/** Verbatim-match-or-drop token replacement. Find the FIRST occurrence of the
 *  exact `oldToken` in `text` and replace it with `newToken`, returning the new
 *  text. Returns null when the token is gone (the user edited the line, or the
 *  bullet changed) -- the signal to keep whatever is there now. No parsing, no
 *  fuzzy match: we only ever touch a token that is still byte-for-byte present.
 *  Shared by the unfurl label swap (ADR 0016) and the Edit Link popover's
 *  write-back (ADR 0005). */
export function replaceLinkToken(
  text: string,
  oldToken: string,
  newToken: string,
): string | null {
  // Delegates to the shared spliceToken (src/plugins/token-kit.ts).
  return spliceToken(text, oldToken, newToken);
}

/** Verbatim-match-or-drop label swap (ADR 0016): replace the FIRST occurrence
 *  of the placeholder `[oldLabel](encodedUrl)` with `[newLabel](encodedUrl)`,
 *  or null when the placeholder is gone. */
export function swapLinkLabel(
  text: string,
  encodedUrl: string,
  oldLabel: string,
  newLabel: string,
): string | null {
  return replaceLinkToken(
    text,
    `[${oldLabel}](${encodedUrl})`,
    `[${newLabel}](${encodedUrl})`,
  );
}
