# PRD: `move_nodes` MCP tool

Status: Implemented (2026-07-03)
ADR: [docs/adr/0027-mcp-move-nodes.md](../../docs/adr/0027-mcp-move-nodes.md)

## Problem

The MCP surface ([ADR 0026](../../docs/adr/0026-agent-native-mcp-server.md)) exposes single-node writes
(`add_node`, `update_node`, `delete_node`, `mirror_node`, daily variants) but **no move/reparent**. The
only way to reorganize an outline over MCP was `add_node` (clone) + `delete_node` (destroy the original)
— which mints new ids, breaks anything referencing the old ones, and takes N calls instead of one atomic
batch. Hit directly while regrouping ~15 daily-note items into three parents.

## Goal

Add one tool, `move_nodes`, that relocates existing nodes (each with its subtree) under a new parent or
to the top level, atomically, **preserving identity** (ids, provenance, mirrors, all state). Scope is
this tool only.

## Non-goals (deferred)

- `group_nodes` (create N parents + move into them in one batch) — falls out of `move_nodes`; fast-follow
  only if the two-call pattern proves annoying. A future in-app "Tidy Up" feature should share the same
  primitive, not fork it.
- `bulk_update_nodes` / `bulk_delete_nodes` — different shape (field edits / removes).
- `position: afterSiblingId` precise anchoring — additive later if needed.
- Dry-run / preview mode — banked for a future destructive `bulk_delete_nodes`.

## Design (locked via grill, 2026-07-03)

**Contract**
- Name: `move_nodes`.
- Input: `nodeIds: string[]` (required) · `newParentId?: string | null` (omit/null = top level) ·
  `position?: "first" | "last"` (default `last`).
- Input order is preserved at the destination.
- Returns one terse line: `Moved N node(s) under "<parent>" (id: …) as the last children.` /
  `... to the top level as the last items.` Failures → `ToolError` (`isError` result) with a specific reason.

**Invariants**
1. **Only `update` ops, ever** — zero insert/delete. Identity/provenance/mirrors preserved by construction.
2. **Atomic all-or-nothing.** Validate up front; on any violation, nothing moves (one `applyBatch` frame).

**Validation → hard reject** (specific reason naming the id):
1. a `nodeId` doesn't exist → `NodeNotFound`
2. `newParentId` doesn't exist (and isn't null) → `NodeNotFound`
3. `newParentId` is a `nodeId` or a descendant of one (cycle) → `WouldCycle`
4. a `nodeId` is a descendant of another `nodeId` in the call → `RedundantDescendant`

**Mirrors** — mirror `newParentId` redirects to true source (`trueSourceOf`); moving mirrors/sources
just works; **no** mirror-cycle guard (render cap covers it; structural cycles stay guarded).

**Protection** — none added; a move can't violate ADR 0015's four rules. Daily container/days are movable
(kv identity survives), matching the in-app editor.

## Implementation

- `planReparent` (pure) + `WouldCycle`/`RedundantDescendant` typed failures in `worker/outline-ops.ts` —
  replays `moveNode`'s chain surgery on a working copy, rebuilds the index between moves, diffs to emit
  updates. Pure twin of the client's `moveManyNodes` (ADR 0021 pattern), anchored on `src/data/tree.ts`.
- `move_nodes` tool registered in `worker/mcp-tools.ts` (placed after `delete_node`).
- Client `moveManyNodes` untouched. No migration, no `Node` field.

## Acceptance criteria

- [x] `move_nodes` appears in `tools/list` (9 tools total), `readOnlyHint: false`.
- [x] Single + batch moves land under the target, input order preserved, `first`/`last` honored.
- [x] Cross-parent batches and mutual-sibling runs keep their chains (no tearing).
- [x] Mirror parent redirects to true source.
- [x] Plan is only `update` ops — ids survive (no recreate).
- [x] All four validations hard-reject atomically (nothing moves) and surface as `isError`.
- [x] `bun run test`, `typecheck:worker`, `typecheck:test`, `lint` all green.

## Verification (2026-07-03)

`bun run test` → 280 pass / 0 fail. `typecheck:worker`, `typecheck:test`, `lint` clean. New coverage:
15 planner cases in `worker/outline-ops.test.ts`, 2 handler cases in `worker/mcp.test.ts`.
