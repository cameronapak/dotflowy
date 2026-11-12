// The source apps an agent can name when it creates nodes over MCP (ADR 0081).
// One list for both sides of the wire: the Worker publishes it as the
// `sourceApp` enum and stamps the canonical spelling into `Node.origin`; the
// provenance plugin keys each app's logo off the same names, and its typed
// table makes a listed app without a logo a compile error.

export const SOURCE_APPS = [
  "Claude",
  "Claude Code",
  "ChatGPT",
  "Codex",
  "Gemini",
  "Gemini CLI",
  "Grok",
  "Cursor",
  "GitHub Copilot",
  "Windsurf",
  "Zed",
  "Cline",
  "OpenCode",
  "Amp",
  "Devin",
  "Poke",
  "Muse",
  "Muse Code",
  "Perplexity",
  "Raycast",
  "Le Chat",
  "Dotflowy CLI",
] as const;

export type SourceApp = (typeof SOURCE_APPS)[number];

const byLowerName = new Map<string, SourceApp>(
  SOURCE_APPS.map((app) => [app.toLowerCase(), app]),
);

/** The listed app an origin names, matched case-insensitively after trimming,
 *  or null for an unlisted name. Also resolves origins stamped before ADR 0081,
 *  which hold the OAuth client's registered name (often "Claude"). */
export function knownSourceApp(origin: string): SourceApp | null {
  return byLowerName.get(origin.trim().toLowerCase()) ?? null;
}
