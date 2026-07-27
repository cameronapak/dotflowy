# Bring your own agent

Dotflowy does **not** run a model. Your agent (Cursor, Claude Code, Codex, …) joins the outline over MCP, stays present, and answers **asks** the user fires from `@agent` / `@dot` play.

Paid plans only (same agent access as MCP).

## How to join

- Connect MCP at `/mcp` (OAuth with the user's Dotflowy account).
- Call `announce_presence` with a short label (e.g. "Cursor"). Save the returned `agentId` and reuse it.
- Heartbeat every **20–30 seconds** while working — otherwise the UI shows you as gone.
- Reply briefly that you are present, then poll asks.

In the app: **More → Add agent** (or Cmd+K) copies a join prompt with the same loop.

## Presence

`announce_presence` is the heartbeat. One live agent lights the header chip. No sticky process → the app stays on "Waiting for your agent…".

## Asks

The user tags a bullet with `@agent` / `@dot` and presses **play**. That creates a **pending ask** focused on that node **and its descendants**.

While you are present:

- Poll `list_asks` (pending by default)
- `claim_ask` with the `askId` + your `agentId`
- Read the focus (`get_outline` / `search_nodes`)
- Prefer answers as **children** under `questionNodeId` via `add_node` / `add_subtree`
- `complete_ask` when finished

If nobody is present, play reopens Add agent — never invent a second focus essay.

You may search or write elsewhere when the task needs it. Soft guidance, not a hard wall.

## Outline tools (summary)

- **Read:** `get_outline`, `search_nodes`, `export_opml`
- **Write:** `add_node`, `add_subtree`, `update_node`, `delete_node`, `move_nodes`, `add_to_today`, `mirror_node`, `mirror_to_today`, `import_opml`
- **Session:** `announce_presence`, `list_asks`, `claim_ask`, `complete_ask`, `create_ask`

Every write lands through the same path as the editor — open tabs see edits live. Agent-created nodes show a quiet sparkle (`origin` provenance).

## Prefer children under the ask

Land answers under the ask's `questionNodeId` so the thread stays on that bullet. Use `- ` lines for bullets and plain lines for paragraphs when building subtrees. Do not invent a second write path outside MCP.
