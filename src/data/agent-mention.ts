import type { Node } from "./tree";

/**
 * Literal `@agent` / `@dot` mention (ADR 0059). Same boundary rules as `#tag`:
 * start or whitespace before, word-boundary after so `@agency` stays literal.
 * `@dot` and `@agent` are interchangeable names for Dot.
 */
export const AGENT_MENTION =
  "(?<=^|\\s)@(?:agent|dot)(?=$|\\s|[^\\p{L}\\p{N}_-])";

const AGENT_RE = new RegExp(AGENT_MENTION, "gu");

const EMPTY: string[] = [];

/** Distinct `@agent`/`@dot` tokens in `text`, first-seen order. */
export function parseAgentMentions(text: string): string[] {
  if (!text.includes("@agent") && !text.includes("@dot")) return EMPTY;
  const out: string[] = [];
  for (const m of text.matchAll(AGENT_RE)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

export function hasAgentMention(text: string): boolean {
  return parseAgentMentions(text).length > 0;
}

/**
 * Seam-K `is:ai` predicate (ADR 0059): part of an exchange — either the user
 * mentioned `@agent`/`@dot` on this line, or the node carries agent `origin`
 * (answer children). Distinct from provenance's `is:agent` (origin-only).
 */
export function isAiNode(node: Node): boolean {
  return hasAgentMention(node.text) || node.origin != null;
}
