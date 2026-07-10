---
status: accepted
---

# The `move_nodes` MCP tool

**What.** The agent-native MCP surface ([ADR 0026](./0026-agent-native-mcp-server.md)) gains a ninth
tool: `move_nodes` — reparent/reorder existing nodes (each with its whole subtree) under a new parent
or to the top level, `nodeIds[]` + optional `newParentId` (null = top level) + optional `position`
(`"first" | "last"`, default `last`), input order preserved. It's the deferral in ADR 0026 coming due
("a `move_node` / full structural tool set in v1 — considered and rejected... move/indent/reorder can
follow once real agent usage shows the need"): regrouping an outline over MCP was only possible by
`add_node` + `delete_node` — clone-and-destroy, which mints new ids and breaks anything pointing at the
old ones. `move_nodes` is the structural primitive that was missing.

## Decisions

**A move is exclusively `update` ops — it never recreates a node.** The single load-bearing invariant.
`planReparent` (worker/outline-ops.ts) only ever relinks `parentId`/`prevSiblingId`; it emits zero
`insert` and zero `delete` ops. So ids, subtrees, `origin` provenance ([node-provenance](./0026-agent-native-mcp-server.md)),
mirrors ([ADR 0022](./0022-node-mirrors.md)), bookmarks, and every other field ride through untouched —
a human-authored node stays human (no provenance diamond) after an agent moves it, because a move
never runs through `newNode` (the only place `origin` is stamped). This is enforced as a test: the plan
is asserted to contain update ops only.

**Validation is atomic all-or-nothing; malformed input is hard-rejected, never partially applied.** The
in-app `moveManyNodes` never validates — it's only ever fed a contiguous sibling run from selection
state ([ADR 0018](./0018-node-multi-selection.md)). An MCP caller passes an arbitrary `nodeIds[]` with
none of those guarantees, so `planReparent` validates up front and fails the _whole_ call (one
`applyBatch` frame, [ADR 0009](./0009-atomic-structural-writes.md), stays all-or-nothing) on any of:
a missing node, a missing parent, a destination inside a moved subtree (`WouldCycle`), or a node listed
alongside its own moved ancestor (`RedundantDescendant`). Rejected: **partial success** ("moved 3 of 5")
— it leaves the agent reasoning about half-applied state; and **drop-and-report** for the
ancestor/descendant overlap — it _guesses intent_ (under `position: "first"` it silently decides the
descendant should stay nested), whereas a hard reject makes zero assumptions and the fix is a one-node
retry. One uniform failure path, fully testable.

**Mirror parents redirect to true source; mirror cycles are deliberately NOT guarded.** A `newParentId`
that is a mirror resolves through `trueSourceOf` so children hang off the content node ([ADR 0022](./0022-node-mirrors.md)),
matching `planAddNode`/`planMirrorNode` (and unlike the client's `moveNode`, which skips the redirect —
an under-specified spot we don't copy). _Structural_ cycles (a node into its own subtree) are hard-guarded
because they corrupt. _Mirror_ cycles are not: the render walk already caps every mirror cycle
(`sourcesOnPath`/`capped`) however it arises, so an unguarded mirror move degrades to a harmless capped
mirror, never a torn chain. And mirror-cycle-on-move is _two-directional_ (a mirror into its source's
tree, and a source into its mirror's render tree) while the existing `wouldMirrorCycle` only models the
one-directional _creation_ shape — a half-guard would be false completeness. So we rely uniformly on the
render cap and document the limit, rather than ship a guard that's correct in one direction only.

**No new protection.** Move is not one of [ADR 0015](./0015-protected-nodes.md)'s four rules
(delete / blank / to-do / complete), and a move only patches structural fields, so `move_nodes` can't
violate any of them by construction — no guard is needed or added. The Daily container and day nodes are
freely movable, exactly as a _user_ can drag them in the editor today; their identity is the kv mapping,
which survives a move. Barring the agent from relocating the container would make the tool stricter than
the human editor — an inconsistency of its own. If the container should ever be pinned, that's an
ADR 0015 amendment applying to both front doors, not a `move_nodes` special case.

**No dry-run.** Reparent is non-destructive (ids and subtrees preserved — a wrong move is reversible by
moving back) and atomic-validated (a malformed move never lands), so there's nothing to preview-and-catch.
Preview belongs at the agent↔user layer — the agent describes its plan in chat and `get_outline`s to
verify — not as a tool-level confirm handshake that doubles the round trips on every safe call. A
dry-run earns its place only on a future _destructive_ `bulk_delete_nodes`.

**Pure twin, not a shared/wrapped implementation.** `planReparent` mirrors the client's
`moveManyNodes`/`moveNode` semantics but is new code, and that's the correct shape, not duplication to
DRY away: the client mutations are _impure_ (they mutate `nodesCollection` through the tree-store's
global `update()`), so they physically can't run server-side. This is the same pure/impure twin pattern
already in the file — `planDeleteNode` ↔ client `removeNode`, `planAddNode` ↔ client insert helpers —
each anchored on the shared `src/data/tree.ts` (`buildTreeIndex`/`childrenOf`/`trueSourceOf`), which is
what bounds drift ([ADR 0021](./0021-effect-first-one-schema-language.md)). `planReparent` replays
`moveNode`'s chain surgery on a working copy, rebuilding the index between moves (the guard that keeps a
run of mutual siblings from tearing its own chain), then diffs the copy to emit the touched updates. The
client `moveManyNodes` is left untouched.

## Considered and rejected

- **Partial success / skip-and-report** on invalid input — leaves half-applied structural state; atomic
  reject fits the one-frame model.
- **Drop-and-report the redundant descendant** — silently guesses the caller wanted it nested; hard
  reject assumes nothing.
- **A mirror-cycle guard on move** — the render cap already makes it non-corrupting, and a correct guard
  is two-directional scope creep; the existing `wouldMirrorCycle` would only half-cover it.
- **`position: afterSiblingId`** (precise anchor placement) — an agent regrouping means append or
  front-load; "after node X" is precision it rarely needs and a purely additive field later.
- **`group_nodes` / `bulk_update_nodes` / `bulk_delete_nodes` in this pass** — `group_nodes` is
  `move_nodes` + N `add_node`s and can be a fast follow if the two-call pattern proves annoying; the
  bulk field/delete tools are a different shape and shouldn't dilute this PR. A future in-app "Tidy Up"
  feature should share the `move_nodes` primitive, not fork it.

## Consequences

- One new tool entry in `worker/mcp-tools.ts` (`move_nodes`) + the `planReparent` planner and two typed
  failures (`WouldCycle`, `RedundantDescendant`) in `worker/outline-ops.ts`; `tools/list` derives itself
  ([ADR 0026](./0026-agent-native-mcp-server.md)). The published tool count is now nine.
- Covered by `worker/outline-ops.test.ts` (the planner: single/batch/cross-parent moves, first/last,
  top-level, mirror-parent redirect, the mutual-sibling no-tear case, the four rejections, and the
  only-`update`-ops invariant) and one `worker/mcp.test.ts` handler case (atomic batch + `isError` on a
  cycle). No new e2e — MCP has no browser caller, the same carve-out as the rest of the surface.
- No migration, no `Node` field, no client change.
