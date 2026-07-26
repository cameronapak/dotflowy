# HANDOFF — inline AI agent (`claude/outliner-ai-agent-inline-bf0e12`)

**Status:** Scaffolding landed (stub fire action + plugin + ghost + runs). Next: real Workers AI tool loop + `getPlan` billing gate + e2e.

## Sources of truth

- Design: [`docs/adr/0059-inline-ai-agent-in-the-outline.md`](./docs/adr/0059-inline-ai-agent-in-the-outline.md)
- Constraining: ADR 0058, 0001, 0009, 0015, 0026, 0031, 0039, 0043, 0047

## Build order

1. ~~Lunora gate + ADR~~
2. ~~Pure logic (TDD): mention / `is:ai` / tools / replace-guard / prompt~~
3. ~~Lunora `runs` table + mutators (create/cancel/complete/patchPartial)~~
4. ~~Plugin surfaces (A/B/C/D/H/K) — degrade when Lunora flag OFF~~
5. ~~Ghost render in RowChrome + ZoomedTitle~~
6. ~~Stub `fireAgentRun` action (canned stream + commit)~~
7. Run engine: Workers AI + restricted tool loop + AI Gateway
8. Paid-plan gate (`getPlan`) before fire
9. e2e via `seedOutlineLunora` (if available)

## Tree state

Worktree: `.claude/worktrees/outliner-ai-agent-inline-bf0e12`
Branch: `claude/outliner-ai-agent-inline-bf0e12`

## Next skills

`security-review` before marking a PR ready (agent egress + paid gate). Dogfood on `bun run cf:dev` with upgraded sync ON.

## Risks

- Stub answers are canned — do not ship as "AI works" without the tool-loop slice.
- Codegen still warns on `v.string().check` maxLength detection for `fireAgentRun` args.
- Delete this file in the shipping PR (must not reach `main`).
