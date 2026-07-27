# HANDOFF — Bring your own agent (ADR 0059)

**Branch:** `feat/byoa-agent-join`  
**Status:** Step 1 (MCP protocol) done; steps 2–5 not started.  
**Do not merge this file to main** — delete in the shipping PR.

## Sources of truth

- [docs/adr/0059-bring-your-own-agent.md](./docs/adr/0059-bring-your-own-agent.md)
- [CONTEXT.md](./CONTEXT.md) — Agent session / Add agent / Ask / Presence
- Grill locks (2026-07-27): Proof-like BYOA; K→rebuild vs PR #323 hosted Dot
- Existing MCP: ADR 0026 + `worker/mcp.ts` paid `agentAccess` (#170)
- Cherry-pick mine: PR #323 / `pr-323` / `claude/outliner-ai-agent-inline-bf0e12` (chrome only)

## Build order

1. **Protocol spike (MCP)** — **DONE**
   - Tools: `announce_presence`, `list_asks`, `claim_ask`, `complete_ask`, `create_ask` (all `agentAccess`-gated like other tools)
   - Storage: classic DO kv collections `agent-presence` + `agent-asks` (allowlisted in `KV_COLLECTIONS` for SPA reads/writes in step 2). Shared schemas/planners in `src/data/agent-session.ts`. Lunora MCP store: upsert throws until Lunora tables exist (classic path is the v1 home).
   - Join prompt: `src/data/agent-join-prompt.ts` → `buildAgentJoinPrompt({ appOrigin })`
   - Tests: `agent-session.test.ts`, `agent-join-prompt.test.ts`, BYOA cases in `worker/mcp.test.ts`

2. **Add agent chrome**
   - Header entry (paid-only; upgrade bait if free)
   - Modal: copy prompt (`buildAgentJoinPrompt`) → Waiting for presence… (poll `/api/kv?collection=agent-presence` + `hasLivePresence` / `PRESENCE_STALE_MS`)
   - Header presence chip when joined

3. **`@agent` / play → Ask**
   - Cherry-pick plugin seams from #323 (widget, play, loader)
   - Play creates Ask (`create_ask` MCP or direct DO upsert via `/api/kv` agent-asks) + pings; no second prompt
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
   - Lunora tables for agent-presence / agent-asks (parity with classic DO kv)

## Explicit non-goals (v1)

- Workers AI / `fireAgentRun` / Lunora `runs` AI loop
- Lunora-only gate
- Second focus prompt on every play
- Zoom root as trust boundary

## Next skills / agents

- Step 2: Add agent modal + presence chip (consume `buildAgentJoinPrompt` + kv poll)
- Implementation: Cursor subagents on this branch (orchestrator stays high-level)
- PR: `/ft-create-concise-pr` when ready; changeset for the feature

## Risks

- MCP polling UX vs Proof SSE — validate with one real Cursor/Claude Code dogfood before H
- Presence without a sticky agent process = false “Waiting…” — join prompt must demand heartbeat
- Cherry-pick from #323 may drag Lunora-only assumptions — strip aggressively
- Lunora beta users: BYOA session kv not wired yet (MCP upsert fails loudly)
