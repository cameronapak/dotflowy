import { CODE_RUN_PATTERN } from "./code";
import { encodeUrlForMarkdown, LINK_PATTERN, sanitizeLinkLabel } from "./links";
import { SPOILER_PATTERN } from "./spoiler";

export interface UnfurlLink {
  token: string;
  url: string;
  start: number;
  end: number;
}

/** Only unlabeled HTTP links outside code, spoilers, and existing link labels.
 * The same scan serves browser input and external writes, never keystrokes. */
export function unfurlLinks(text: string): UnfurlLink[] {
  const pattern = new RegExp(
    `${CODE_RUN_PATTERN}|${SPOILER_PATTERN}|${LINK_PATTERN}|https?:\\/\\/[^\\s<>\\x60|\\[\\]]+`,
    "gi",
  );
  const links: UnfurlLink[] = [];
  for (const match of text.matchAll(pattern)) {
    let token = match[0];
    let url: string;
    if (token.startsWith("[")) {
      const parts = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token);
      if (!parts || encodeUrlForMarkdown(parts[1]!) !== parts[2]) continue;
      url = parts[2]!;
    } else if (/^https?:\/\//i.test(token)) {
      // Sentence punctuation and unmatched closing parentheses aren't URL data.
      token = token.replace(/[.,;:!?]+$/, "");
      while (
        token.endsWith(")") &&
        (token.match(/\)/g)?.length ?? 0) > (token.match(/\(/g)?.length ?? 0)
      )
        token = token.slice(0, -1);
      url = encodeUrlForMarkdown(token);
    } else continue;
    try {
      const parsed = new URL(url);
      if (
        !/^https?:$/.test(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        continue;
    } catch {
      continue;
    }
    links.push({
      token,
      url,
      start: match.index,
      end: match.index + token.length,
    });
  }
  return links;
}

/** Conservative on updates: a URL already present in the old source is never
 * backfilled, even if it is also pasted a second time. */
export function newUnfurlLinks(before: string, text: string): UnfurlLink[] {
  return unfurlLinks(text).filter(
    ({ url, token }) =>
      !before.includes(url) &&
      !before.includes(token) &&
      !before.includes(url.replace(/%28/g, "(").replace(/%29/g, ")")),
  );
}

/** Rescan live source so a late result cannot alter custom labels or content
 * that has since been wrapped in code/spoiler markup. */
export function applyUnfurlTitle(
  text: string,
  link: UnfurlLink,
  title: string,
): string {
  const label = sanitizeLinkLabel(title);
  if (!label) return text;
  const matches = unfurlLinks(text).filter(
    (candidate) => candidate.token === link.token,
  );
  for (const match of matches.reverse()) {
    text =
      text.slice(0, match.start) +
      `[${label}](${link.url})` +
      text.slice(match.end);
  }
  return text;
}
