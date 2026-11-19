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

Tools that create nodes require `sourceApp`: the app the agent runs in, such as
`Claude`, `ChatGPT`, or `Cursor`. Pick a listed app or give any name. The editor
shows that app's logo on each node the call creates, and `is:agent` finds them.
See [ADR 0081](./adr/0081-source-app-attribution.md).

For terminal access, use the [Dotflowy CLI](../cli/README.md). Settings →
Connections has setup actions for MCP apps and the CLI, plus unified API key
management. Outline tools through MCP and CLI require Pro or Founding and preserve
spoiler redaction. Authenticated Free accounts can call the read-only
`get_pro_trial` tool for a browser setup link. It never starts a trial or
authorizes payment: sign in and choose **Start 14-day Pro trial** in Settings,
then complete Stripe Checkout. No card is required. Without a payment method
the trial cancels after 14 days; a saved or added payment method can enable the
disclosed $5/month renewal. Eligibility is once per account, excluding current
paid/comped accounts and accounts with prior trials or unresolved billing.
Clients that support a manually configured bearer can use a personal
API key instead of OAuth. Create it in **Dotflowy Settings → Connections → API
keys**: Read-only permits outline reads, search, and export; Read and write
permits all tools. The server filters tool discovery and rejects direct write
calls for a read-only key. Capture only permits `/api/capture`, not MCP or CLI.
Keys default to 30 days and cannot exceed 90 days. Revocation takes effect on the
next request. Rotation replaces the secret immediately while preserving permission;
update every client that uses it. For a handoff without interruption, create a
separate key, update clients, then revoke the old one. Verified account owners
receive an email reminder within seven days of expiration. API keys never
authenticate browser APIs or key management.
Turning Daily notes off
in Settings → Plugins does not disable explicit MCP or CLI daily operations.

## OAuth consent and revocation

Connected AI agents may need to reconnect once as Dotflowy updates its
authentication infrastructure to Better Auth 1.7. Existing OAuth credentials
are reset; personal API keys and browser sessions are unaffected. Use the same
MCP URL and sign in again (CLI: `dotflowy login`).

Missing or invalid credentials on `/mcp` and `/api/mcp` return HTTP 401 with
`error: "unauthorized"` and an `error_description` explaining how to reconnect
in your AI app's connector settings or run `dotflowy login`. The same message
is used for every invalid credential. The `WWW-Authenticate` protected-resource
metadata challenge and CORS headers remain available for OAuth discovery.
This is an HTTP authentication error, not a JSON-RPC response; whether an AI
app displays the description or starts reauthorization depends on the client.

Every new OAuth authorization requires explicit approval in Dotflowy, even if
the client omits `prompt=consent`. The consent page shows the authenticated
account, registered client name, callback hostname, full-outline read/write
permissions, and offline access when requested. Client names are self-declared,
not evidence that Dotflowy verified the app. OAuth has no read-only or subtree
scope; `openid`, `profile`, `email`, and `offline_access` describe identity and
refresh behavior, not outline permissions. Use a read-only API key when supported.

Settings → Connections → Authorized apps lists clients with active credentials.
Revoke removes **all access and refresh tokens** for that user/client, its saved
consents and pending authorization codes. It does not disable the shared client
registration, affect another user, revoke personal API keys, stop work already
authorized by an in-flight request, or erase copies held by the client. Removing
the connector in the AI app alone may not revoke its tokens.

Root and `/mcp`-suffixed protected-resource discovery both identify the full
`https://<your-deployment>/mcp` URL. The retained `/api/mcp` alias has its own
path-aware discovery document. API keys remain valid across the 1.7 upgrade;
OAuth agents reconnect once. New authorization uses S256 PKCE and explicit consent;
successful refresh consumes the previous refresh grant and invalidates the prior
access token. A client must save the new pair: replaying the old refresh token
revokes the client's refresh family for that user.

## Tool annotations

`get_pro_trial`, `get_outline`, `search_nodes`, and `export_opml` are read-only. `update_node`,
`delete_node`, and `move_nodes` are destructive because they can replace or
remove existing content or structure. Add, mirror, and import tools remain
non-destructive: they add nodes, and import never replaces an existing outline.
`add_node`, `add_subtree`, `update_node`, and `add_to_today` advertise
`openWorldHint: true` because text writes can fetch public link titles. Other
tools advertise a closed world. Annotations guide client confirmation UI; the
server's credentials, permission checks, and mutation guards enforce access.

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
`date`, or the top level), lands it as one atomic batch with the caller's
`sourceApp` stamp, and answers with a compact receipt (root ids, counts, the
fidelity-degradation tally) — `dryRun: true` previews that receipt without
writing; `export_opml` mirrors `get_outline` scoping and returns the raw OPML
string. Both are capped at 5,000 nodes and reject rather than truncate — a
full Workflowy migration belongs in the app UI.

## Adding a tool

When you add an MCP tool, update the ordered tool-name list in
`worker/mcp.test.ts`. The test asserts the registry order, not just presence.
