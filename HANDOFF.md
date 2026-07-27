# HANDOFF — Bring your own agent (ADR 0059)

**Branch:** `feat/byoa-agent-join`  
**Status:** Steps 1–5 done (v1 complete). Later items deferred.  
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

2. **Add agent chrome** — **DONE**
   - Header More + Cmd+K **Add agent** → `openAddAgent()`; free = Settings upgrade bait (client `subscription.list`; MCP still server-gates)
   - Modal: `buildAgentJoinPrompt` → **Copy for agent** → **Waiting for your agent…**; polls `agent-presence` via `src/data/agent-presence.ts` + `hasLivePresence` / `freshestLivePresence`
   - Header `AgentPresenceChip` when live (label = freshest agent); click reopens modal
   - Mount: `AddAgent` in `__root.tsx` (beside QuickAdd)

3. **`@agent` / play → Ask** — **DONE**
   - Plugin `src/plugins/agent/` (Seams A widget, B play/stop, C `/ask` tag-only, H `@` picker, K `is:ai`)
   - Mention parse: `src/data/agent-mention.ts` (from #323, no fireAgent)
   - Play gate: `decideAgentPlay` → no presence → `openAddAgent()`; else SPA upsert pending ask via `agent-asks` kv (`createPendingAsk` / `planCreateAsk`)
   - Busy: pending|claimed → Loader2 + Stop; Stop → `planCancelAsk` / `cancelActiveAsk`
   - **No** Workers AI / `fireAgent` / Lunora runs / BrailleLoader-as-AI / Run confirm popover
   - Loader: lucide `Loader2` for v1 (Dotmatrix polish deferred — see step 4 notes)

4. **Answer landing** — **DONE** (light)
   - Children-of-ask already steered in join prompt + MCP tool copy (`announce_presence` / `list_asks` / `claim_ask` responses) — no new mutation path
   - Provenance sparkle already works: MCP stamps `origin` at write choke point; `src/plugins/provenance/` Seam F mark + `is:agent` — no #323 glue needed
   - Soft-reload / arrive animation — **deferred** (no trivial reuse without hosted stream)
   - Dotmatrix loader swap — **deferred** (shadcn registry install / non-trivial; keep `Loader2`)

5. **Docs surface** — **DONE**
   - Public SPA `/agent-docs` (`src/routes/agent-docs.tsx` + `PUBLIC_ROUTES`) renders `docs/agent-docs.md` via `LegalPage`
   - Raw mirror `public/agent-docs.md` for agent curl; join prompt links both `/agent-docs` and `/agent-docs.md`
   - Keep the two markdown files in sync when editing

6. **Later (not v1)**
   - HTTP `events/stream` (M→H)
   - Scoped run token in prompt (D→B)
   - Local companion / ACP sandbox (parked)
   - Lunora tables for agent-presence / agent-asks (parity with classic DO kv)
   - Dotmatrix busy loader; soft arrive animation for answer children

## Explicit non-goals (v1)

- Workers AI / `fireAgentRun` / Lunora `runs` AI loop
- Lunora-only gate
- Second focus prompt on every play
- Zoom root as trust boundary

## Next skills / agents

- Dogfood: one real Cursor/Claude Code join → play → children answer before merge
- PR: `/ft-create-concise-pr` when ready; minor changeset added for BYOA

## Risks

- MCP polling UX vs Proof SSE — validate with one real Cursor/Claude Code dogfood before H
- Presence without a sticky agent process = false “Waiting…” — join prompt must demand heartbeat
- Cherry-pick from #323 may drag Lunora-only assumptions — strip aggressively (**done for step 3**)
- Lunora beta users: BYOA session kv not wired yet (MCP upsert fails loudly)
- Cancel is SPA-side only (marks ask `cancelled`); agent may still write if it already claimed — acceptable v1
- `docs/agent-docs.md` ↔ `public/agent-docs.md` dual copy — edit both (or drop the public mirror later)
