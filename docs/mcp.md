# Agents (MCP)

The outline is reachable by AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io): point an MCP client
at `https://<your-deployment>/mcp` and it walks the standard OAuth flow (sign
in with your normal account; the client registers itself).

Agents get read tools (`get_outline`, `search_nodes`, `export_opml`) and write
tools (`add_node`, `add_subtree`, `update_node`, `delete_node`, `move_nodes`,
`add_to_today`, `mirror_node`, `mirror_to_today`, `import_opml`); every write
lands through the same atomic per-user Durable Object path as the editor, so
open tabs see agent edits live. Design + rejected alternatives:
[the agent-native MCP server](./adr/0026-agent-native-mcp-server.md).

## OPML over MCP

The OPML pair speaks the Workflowy dialect through the same shared core as the
app's own import/export ([ADR 0037](./adr/0037-opml-import-export.md)):
`import_opml` takes an OPML string (targeted like `add_subtree` — `parentId`,
`date`, or the top level), lands it as one atomic batch with the agent's
provenance stamp, and answers with a compact receipt (root ids, counts, the
fidelity-degradation tally) — `dryRun: true` previews that receipt without
writing; `export_opml` mirrors `get_outline` scoping and returns the raw OPML
string. Both are capped at 5,000 nodes and reject rather than truncate — a
full Workflowy migration belongs in the app UI.
