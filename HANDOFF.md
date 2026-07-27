# HANDOFF — Bring your own agent (ADR 0059)

**Branch:** `feat/byoa-agent-join`  
**Status:** Decisions locked; docs landed; implementation not started.  
**Do not merge this file to main** — delete in the shipping PR.

## Sources of truth

- [docs/adr/0059-bring-your-own-agent.md](./docs/adr/0059-bring-your-own-agent.md)
- [CONTEXT.md](./CONTEXT.md) — Agent session / Add agent / Ask / Presence
- Grill locks (2026-07-27): Proof-like BYOA; K→rebuild vs PR #323 hosted Dot
- Existing MCP: ADR 0026 + `worker/mcp.ts` paid `agentAccess` (#170)
- Cherry-pick mine: PR #323 / `pr-323` / `claude/outliner-ai-agent-inline-bf0e12` (chrome only)

## Build order

1. **Protocol spike (MCP)**
   - Tools (names TBD): join/presence heartbeat, list/ack pending asks
   - Ask record: question node id, status, timestamps; paid gate same as MCP
   - Join prompt markdown (Proof-shaped): presence → ready → poll asks → write children under focus; lazy skill/docs URLs

2. **Add agent chrome**
   - Header entry (paid-only; upgrade bait if free)
   - Modal: copy prompt → Waiting for presence…
   - Header presence chip when joined

3. **`@agent` / play → Ask**
   - Cherry-pick plugin seams from #323 (widget, play, loader)
   - Play creates Ask + pings; no second prompt
   - No listener → reopen Add agent
   - Row busy while ask active

4. **Answer landing**
   - Prompt/tools steer children-of-ask; provenance sparkle from #323 if useful
   - Soft-reload / arrive animation only if still needed without hosted stream

5. **Docs surface**
   - Public `/agent-docs` + skill URL referenced from join prompt (lazy)

6. **Later (not v1)**
   - HTTP `events/stream` (M→H)
   - Scoped run token in prompt (D→B)
   - Local companion / ACP sandbox (parked)

## Explicit non-goals (v1)

- Workers AI / `fireAgentRun` / Lunora `runs` AI loop
- Lunora-only gate
- Second focus prompt on every play
- Zoom root as trust boundary

## Next skills / agents

- Implementation: Cursor subagents on this branch (orchestrator stays high-level)
- Clarity rounds: `batch-grill-me` or `grill-with-docs`
- PR: `/ft-create-concise-pr` when ready; changeset for the feature

## Risks

- MCP polling UX vs Proof SSE — validate with one real Cursor/Claude Code dogfood before H
- Presence without a sticky agent process = false “Waiting…” — join prompt must demand heartbeat
- Cherry-pick from #323 may drag Lunora-only assumptions — strip aggressively
