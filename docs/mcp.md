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

For terminal access, use the [Dotflowy CLI](../cli/README.md). Settings →
Connections has separate setup actions for MCP apps and the CLI. Both require
Unlimited or Founding and preserve spoiler redaction. Turning Daily notes off
in Editor features does not disable explicit MCP or CLI daily operations.

## Search with DQL

`search_nodes` uses DQL (Dotflowy Query Language), the same grammar as the app's
filter. For example, these arguments find incomplete tasks tagged `#dotflowy`:

```json
{ "query": "is:todo -is:complete #dotflowy" }
```

Spaces mean AND, `-` negates a term, and uppercase `OR` joins adjacent terms.
Quotes preserve a phrase: `release notes` matches both words anywhere in the same
node; `"release notes"` matches the phrase. **Existing substring-search callers
must quote multiword phrases to keep their previous behavior.** Text matching is
case-insensitive and uses flattened reading text. Tags are exact and
case-sensitive, and do not inherit from parents. Unknown operators match literal
text.

Supported operators include `is:todo`, `is:bullet`, `is:paragraph`, `is:complete`,
`is:mirror`, `is:agent`, `has:link`, `highlight:`, and `highlight:COLOR`.
Colors are `red`, `orange`, `yellow`, `green`, `blue`, and `purple`.
Date ranges, sorting expressions, and parentheses are not supported.

Search covers the whole outline by default. Supply `nodeId` to include that node
and its reachable descendants, including mirrored subtrees. Collapse and
hide-completed settings do not restrict agent search. Mirrors match source
content, while `is:mirror` tests the instance. Each node ID appears once, with
breadcrumbs from the first path encountered in outline order.

Results contain readable `content` and
`structuredContent: { nodes, nextCursor }`. Each node includes `id`, `text`,
`kind`, `isTask`, `completed`, `mirrorOf`, and a `path` of ancestor text.
Spoilers are redacted before all matching and in both result formats and
breadcrumbs. Unlike the app's contextual filter rows, only matches are returned.

Pages default to 25 matches; `limit` accepts 1 through 100. When `nextCursor` is
not null, repeat the same query, scope, and limit with that value as `cursor`.
A null cursor means the result is complete. If searchable data or the day used
to evaluate date labels changes, the server rejects continuation and asks you
to restart without the cursor. Edits confined to spoiler interiors do not
invalidate continuation.

The [CLI](../cli/README.md) uses this same tool:

```sh
dotflowy search 'is:todo -is:complete #dotflowy'
dotflowy search 'is:todo -is:complete #dotflowy' --node NODE_ID --limit 100 --all --json
```

The first command returns one page. `--cursor` continues a page; `--all` starts
from the beginning and validates every page before printing a combined result.
It fails without partial output if continuation fails.
Design: [ADR 0063](./adr/0063-dql-search-parity.md).

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

## Adding a tool

When you add an MCP tool, update the ordered tool-name list in
`worker/mcp.test.ts`. The test asserts the registry order, not just presence.
