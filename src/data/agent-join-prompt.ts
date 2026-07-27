/**
 * Proof-shaped join prompt for bring-your-own-agent (ADR 0059).
 * Pure markdown — copied from Add agent chrome (step 2); no DOM.
 */

export type JoinPromptOptions = {
  /** Public origin, e.g. https://app.dotflowy.com — used for MCP + docs URLs. */
  appOrigin?: string;
  /** Future agent skill/docs path (lazy; may 404 until step 5). */
  docsPath?: string;
};

const DEFAULT_DOCS_PATH = "/agent-docs";

/**
 * One copy-paste block: connect MCP → announce presence → poll asks →
 * answer as children under the ask focus → complete.
 */
export function buildAgentJoinPrompt(opts: JoinPromptOptions = {}): string {
  const origin = (opts.appOrigin ?? "https://app.dotflowy.com").replace(
    /\/$/,
    "",
  );
  const docsPath = opts.docsPath ?? DEFAULT_DOCS_PATH;
  const docsUrl = `${origin}${docsPath.startsWith("/") ? docsPath : `/${docsPath}`}`;
  const mcpUrl = `${origin}/mcp`;

  return `# Join this Dotflowy outline

You are connecting as the user's **bring-your-own agent**. Dotflowy does not run a model — you are the agent. Stay connected for the whole session.

## 1. Connect MCP

Connect to the Dotflowy MCP server (OAuth):

\`${mcpUrl}\`

Use the outline tools (\`get_outline\`, \`search_nodes\`, \`add_node\`, \`add_subtree\`, \`update_node\`, …) for all writes. Do **not** invent a second write path.

## 2. Announce presence (heartbeat)

Call \`announce_presence\` with a short \`label\` (e.g. "Cursor", "Claude Code").

- Save the returned \`agentId\` and **reuse it on every heartbeat**.
- Heartbeat about every **20–30 seconds** while you are working (or the UI shows you as gone).
- Call \`announce_presence\` again whenever you resume after a pause.

## 3. Poll asks

While present, poll \`list_asks\` (defaults to \`pending\`).

When you take work:

1. \`claim_ask\` with that \`askId\` + your \`agentId\`
2. Focus = \`questionNodeId\` **and its descendants** (read with \`get_outline\` / \`search_nodes\` as needed)
3. Prefer answers as **children** under \`questionNodeId\` (\`add_node\` / \`add_subtree\` with \`parentId\`)
4. You may search/write elsewhere when the task needs it — soft guidance, not a hard wall
5. \`complete_ask\` when finished

If \`list_asks\` is empty, stay present and keep polling / heartbeating — the user may play an \`@agent\` ask next.

## 4. Docs (optional)

Protocol notes (may be sparse until filled in): ${docsUrl}

## Ready check

After first \`announce_presence\` succeeds, you are **joined**. Reply briefly that you are present and waiting for asks — then heartbeat + poll.
`;
}
