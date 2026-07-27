/**
 * Map MCP OAuth client `origin` strings → display name + known brand mark.
 * Case-insensitive substring match; unknown → sparkle. Brand marks are
 * attribution-only (official geometry when cleared; else sparkle until cleared).
 */

export type HarnessKind = "dot" | "chatgpt" | "sparkle";

export type HarnessMark = {
  kind: HarnessKind;
  /** Tooltip / aria label stem: "Created by {displayName} · …" */
  displayName: string;
};

/** Pure: resolve a Node.origin stamp to chrome. */
export function resolveHarnessMark(origin: string): HarnessMark {
  const o = origin.trim();
  const lower = o.toLowerCase();

  if (lower === "agent" || lower === "dot") {
    return { kind: "dot", displayName: "Dot" };
  }
  if (lower.includes("chatgpt") || lower.includes("openai")) {
    return { kind: "chatgpt", displayName: "ChatGPT" };
  }
  // Claude / Anthropic / Cursor: sparkle until an official brand-guideline-ok
  // mark is cleared for attribution use (same discipline as OpenAI Blossom).
  if (lower.includes("claude") || lower.includes("anthropic")) {
    return { kind: "sparkle", displayName: "Claude" };
  }
  if (lower.includes("cursor")) {
    return { kind: "sparkle", displayName: "Cursor" };
  }
  return { kind: "sparkle", displayName: o || "agent" };
}
