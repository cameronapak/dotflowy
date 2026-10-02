---
status: accepted
---

# DQL across the app, MCP, and CLI

The app's filter understands operators, but MCP `search_nodes` only matches a
single text substring. The CLI calls MCP. DQL (Dotflowy Query Language) names the
existing grammar from [ADR 0047](./0047-query-filter-grammar.md), rather than a
second language for agents.

## Decisions agreed during design

- **Reuse the existing grammar.** The first change exposes the app's operators,
  spaces as AND, negation, quotes, and adjacent-term `OR` through MCP and CLI.
  Date ranges, sorting expressions, and parentheses are outside this change.
- **Extend `search_nodes.query`.** Do not introduce a separate DQL tool or mode.
  This intentionally changes an unquoted `release notes` from one substring to
  two AND terms. Callers use `"release notes"` for the existing phrase behavior.
  One contract avoids two search modes that callers must choose between.
- **Keep conditions on the same node.** A parent's `#dotflowy` tag does not make
  its untagged task child match `is:todo -is:complete #dotflowy`. Tags do not
  inherit, including under negation.
- **Make every match retrievable through bounded pagination.** Small responses
  remain the default, but callers can continue instead of stopping at the
  current 25-match cap. Continuation must be explicit so an agent can distinguish
  a complete result from a partial one.
- **Search the whole outline by default, with optional `nodeId` scope.** A scope
  includes its root and descendants. Collapse and the app's hide-completed
  setting do not constrain agent search; callers exclude completed nodes with
  DQL explicitly.
- **Match mirrors against source content.** Text, tags, kind, completion, and
  other content conditions read the source; `is:mirror` reads the instance.
  Return each matching source or mirror node with its own ID and location.
  Update app matching to the same rule rather than preserving the current
  mismatch between a mirror's stored fields and displayed content.
- **Return readable text and structured page data.** MCP `structuredContent`
  contains matching nodes, breadcrumbs, task/completion state, mirror identity,
  and `nextCursor`. Scripts must not need to parse prose to retrieve node IDs.
  Both representations preserve spoiler redaction.
- **Reject stale continuation instead of mixing snapshots.** If the searchable
  outline or date-label evaluation day changes between pages, return an explicit
  error instructing the caller to restart. Capture one day per request for both
  matching and continuation validation. This trades restart cost for a complete,
  consistent result without storing server-side snapshots. Changes confined to
  redacted spoiler interiors must not invalidate a cursor.
- **Keep CLI search bounded by default, with explicit `--all`.** Ordinary search
  returns one page with an explicit continuation indicator. Offer scope,
  page-size, and cursor options. With `--all`, collect and validate every page
  before printing a combined result; fail clearly if the outline changes rather
  than presenting a partial list as complete. JSON output includes the
  structured records.
- **Follow mirrored subtrees within a scope.** Search the content reachable
  through mirrors, as `get_outline` does, with the existing mirror-cycle guard.
  Return each node ID once per search even if multiple paths reach it. Distinct
  mirror nodes keep their own IDs. Breadcrumbs show the first path encountered
  within the searched view, so a task reached through a project mirror in Today
  appears in a search scoped to Today.

## Existing constraints

The core owns parsing; feature owners supply operator meaning. Share pure
matching code without importing browser plugin UI into the Worker. The CLI
continues to call MCP, preserving server validation and the spoiler boundary
([ADR 0061](./0061-cli-mcp-compatibility.md)).

Spoiler interiors must not influence agent matching or appear in results,
breadcrumbs, or continuation data. Redact before evaluating text-derived
conditions, not only before displaying results
([ADR 0043](./0043-spoilers-redacted-from-agents.md)).

The app's filter remains a view transform, not navigation. Sharing the language
does not require MCP to return the app's contextual ancestors and revealed
descendants as matches. App visibility and dimming use render-path keys, so
revealing children under an expanded mirror does not reveal them under a
collapsed source or another collapsed mirror. Agent results still deduplicate
by node ID.

## Implementation

The user confirmed the design and authorized implementation. Pages default to
25 matches and accept a limit from 1 to 100. The Worker shares the app's parser
and pure plugin-owned operator definitions; the CLI calls `search_nodes`.
