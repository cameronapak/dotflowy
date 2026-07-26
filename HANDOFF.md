# HANDOFF — inline AI agent (`claude/outliner-ai-agent-inline-bf0e12`)

**Status:** Scope C engine landed — Workers AI tool loop + `getPlan` paid gate + e2e mock. Architecture choice: **plain Lunora action** (not `@lunora/workflow` / `@lunora/agent`) with cooperative cancel between stream patches. Delete this file in the shipping PR.

## Sources of truth

- Design: [`docs/adr/0059-inline-ai-agent-in-the-outline.md`](./docs/adr/0059-inline-ai-agent-in-the-outline.md)
- Engine: `lunora/agent.ts` (`streamText` + allowlisted MCP tools)
- Constraining: ADR 0058, 0001, 0009, 0015, 0026, 0031, 0039, 0043, 0047

## Build order

1. ~~Lunora gate + ADR~~
2. ~~Pure logic (TDD): mention / `is:ai` / tools / replace-guard / prompt~~
3. ~~Lunora `runs` table + mutators (create/cancel/complete/patchPartial)~~
4. ~~Plugin surfaces (A/B/C/D/H/K) — degrade when Lunora flag OFF~~
5. ~~Ghost render in RowChrome + ZoomedTitle~~
6. ~~Stub `fireAgentRun` action (canned stream + commit)~~
7. ~~Run engine: Workers AI + restricted tool loop + AI Gateway env~~
8. ~~Paid-plan gate (`getPlan`) before fire~~
9. ~~e2e via `seedOutlineLunora` (`e2e/agent-inline.spec.ts`)~~

## Architecture choice (locked for this branch)

- **Custom `runs` table + `@lunora/ai` `streamText`** — not `@lunora/agent` / chat threads.
- **Plain `action`**, not `@lunora/workflow`: same cooperative cancel the stub used; avoids workflow registry/wrangler rabbit hole for v1. Revisit if runs hit the ~10m action ceiling in dogfood.
- Model: `@cf/zai-org/glm-4.7-flash` via `ctx.ai` / `env.AI`. Gateway: optional `LUNORA_AI_GATEWAY_ACCOUNT_ID` + `_ID` (+ `_TOKEN`).
- Tools: `lunora/agent-ai-tools.ts` wraps allowlisted `worker/mcp-tools` handlers.
- Billing: `getPlan` on `ctx.env.DB` before `createAgentRun` / AI — fail closed for free.

## Tree state

Worktree: `.claude/worktrees/outliner-ai-agent-inline-bf0e12`
Branch: `claude/outliner-ai-agent-inline-bf0e12`

## Next skills

`security-review` before marking a PR ready (agent egress + paid gate). Dogfood on `bun run cf:dev` with upgraded sync ON + a paid (or operator-comped) plan row.

## Risks

- e2e mocks `agent:fireAgentRun` (no real Workers AI / getPlan) — dogfood still required for model/tool quality + paid gate.
- Lunora-only fire is enforced on the client today; a direct RPC could still hit the action (same class of gap as other Lunora mutators — follow-up if needed).
- Codegen still warns on `v.string().check` maxLength detection for `fireAgentRun` args.
- Delete this file in the shipping PR (must not reach `main`).
