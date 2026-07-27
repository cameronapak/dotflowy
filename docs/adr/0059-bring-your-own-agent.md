---
status: accepted
---

# Bring your own agent (no hosted inference)

Dotflowy does **not** run a model for the user. External coding agents (Cursor,
Claude Code, Codex, …) join the outline the way Proof invites an agent into a
doc: one copy-paste prompt, presence, then work. The app provides the outline
surface, MCP tools, join/ask protocol, and chrome — the user already pays for
their agent. Rejected: hosting Workers AI / ACP-sandbox CLIs inside Dotflowy
(app-paid inference, and not “my” agent).

## Product shape

- **Join is the spine.** Header **Add agent** opens a Proof-like modal: copy
  one protocol prompt → “Waiting for your agent…” until presence arrives.
  Ongoing **agent session** over the **whole outline** (same power surface as
  MCP today).
- **Ask focuses work.** An `@agent` / `@dot` mention marks a node; **play**
  emits an **ask** (event ping) whose focus is that node **and its
  descendants**. No second prompt while someone is present. If nobody is
  listening, reopen Add agent (same join prompt — never invent a focus essay).
- **Answers prefer children** of the ask node (prompt + tool guidance). MCP is
  not hard-walled — `search_nodes` / writes elsewhere remain available when
  needed.
- **Presence chrome:** header chip for the session; row busy state on the
  active ask (reuse play/stop/loader patterns from the shelved hosted-Dot work).
- **Gate:** paid plans only — same `agentAccess` entitlement as MCP (#170).
  Not Lunora-required (MCP already works on classic).

## Protocol (staged)

1. **v1 — MCP.** Extend the existing OAuth MCP server: join/presence + pending
   asks the agent can poll; mutations stay today’s tools. Join prompt teaches
   the loop (presence → ready → poll asks → write children).
2. **Later — HTTP events/stream.** Proof-style SSE/stream when polling hurts;
   mutations can stay MCP. Scoped run tokens (token-in-prompt) harden trust
   after the loop is real — start on existing MCP OAuth.

## Relationship to prior work

PR #323 / draft “inline hosted Dot” (Workers AI `fireAgentRun`, Lunora `runs`,
paid AI loop) is **not** the product. **K→rebuild:** cherry-pick useful chrome
and seams (`@agent` widget, play affordance, answer-as-children, provenance,
tests worth keeping); do not ship app-hosted inference. A draft ADR on that
branch for hosted Dot is superseded by this decision.

## Considered and rejected

- **Hosted Workers AI / TanStack ACP sandbox / AI SDK ACP in-cloud** — still
  Dotflowy’s runtime and usually Dotflowy’s bill; not the user’s Cursor
  session.
- **Local ACP + Cloudflare Tunnel as v1** — plausible companion later; heavy
  ops; not required for BYOA.
- **Zoom root as join boundary** — zoom is a view, not a trust boundary; whole
  outline + ask-focus matches how agents already use MCP.
- **Second “focus” paste on every play** — fights ongoing session; play is a
  ping.

## Consequences

- Agent-native docs/skill URLs (lazy, Proof-style) become part of the join
  prompt — deepen only if needed.
- Presence and asks are new domain objects beside MCP tool calls; they must not
  become a second mutation path around `applyBatch` / Lunora mutators.
- Free users keep seeing upgrade bait for agent access (unchanged MCP posture).
