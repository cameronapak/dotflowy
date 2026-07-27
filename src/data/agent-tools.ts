/**
 * Model-callable tool allowlist for the inline agent (ADR 0059).
 * Read + additive only. Destructive work stays in a deliberate MCP session.
 * The engine's own re-fire replace is engine code, not a model tool.
 */

export const AGENT_ALLOWED_TOOLS = [
  "get_outline",
  "search_nodes",
  "export_opml",
  "add_node",
  "add_subtree",
  "add_to_today",
  "mirror_node",
  "mirror_to_today",
  /** Firecrawl-backed; omitted at runtime when `FIRECRAWL_API_KEY` is unset. */
  "web_search",
] as const;

export type AgentAllowedTool = (typeof AGENT_ALLOWED_TOOLS)[number];

export const AGENT_DENIED_TOOLS = [
  "update_node",
  "delete_node",
  "move_nodes",
  "import_opml",
] as const;

const ALLOWED = new Set<string>(AGENT_ALLOWED_TOOLS);

export function isAgentToolAllowed(name: string): boolean {
  return ALLOWED.has(name);
}
