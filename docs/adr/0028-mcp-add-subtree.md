---
status: accepted
---

# The `add_subtree` MCP tool

**What.** The agent-native MCP surface ([ADR 0026](./0026-agent-native-mcp-server.md)) gains a tenth
tool: `add_subtree` — create a whole nested forest of fresh bullets in ONE atomic call, under a parent,
at the top level, or on a day's daily note. Input is a recursive `nodes: NodeInput[]` where
`NodeInput = { text, isTask?, children? }`, plus an optional `parentId` (null/omitted = top level), an
optional `date` (YYYY-MM-DD, targets the daily note like `add_to_today`), and one root-level `position`
(`"first" | "last"`, default `last`). It returns the created forest rendered as an indented bullet list
with every node's id inline (the `get_outline` format). The motivating incident: saving a research
outline onto the user's daily note took ~15 sequential `add_node` calls. The DO already applies an
arbitrary op array atomically in one sync frame (`applyBatch`, [ADR 0009](./0009-atomic-structural-writes.md)),
and every existing write tool plans exactly one node — so the batch tool is the missing shape, not new
infrastructure. `add_node` (single bullet) stays; `add_subtree` is the many/nested sibling.

## Decisions

**Nested `children` recursion, NOT a flat `tempId`/`parentTempId` list or an indented-markdown string.**
The input is the tree the agent is already holding; it hands it over verbatim. This is the load-bearing
contract call, and it's the published schema ([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)'s
one-source rule: the Effect Schema that gates `tools/call` IS what `tools/list` publishes), so it's hard
to reverse. Recursion is expressed with `Schema.suspend`; `tools/list` already emits `$ref`/`$defs`
(`worker/mcp.ts`), verified to publish cleanly for the clients we target (Claude and spec-following MCP
clients tolerate recursive JSON Schema). Rejected: **flat `tempId` + `parentTempId`** — recursion-free
(insurance against a stricter client we don't have), but uglier for the agent to author and it invents a
new class of authoring error (dangling parent ref, temp-id cycles) plus a topological-sort/validation
burden server-side. Rejected: **indented-markdown string** — one arg, trivial schema, but trades a schema
problem for a *parser* problem (tab-vs-space, level width, task detection, escaping) whose failure mode is
silent mis-nesting. Nested is also the only option where the sibling-chain trap below vanishes *by
construction* instead of being *guarded*.

**Sibling links are wired correct-by-construction, NOT by looping `planAddNode`.** The trap: `planAddNode`
reads `childrenOf(index, parentId)` to find the last sibling, so looping it over the *same* snapshot makes
every new top-level node compute the *same* `prevSiblingId` and tear the chain — the identical hazard
`planReparent`/`moveManyNodes` guard with "rebuild the index between moves." `planAddSubtree` sidesteps it:
the agent handed us the whole tree, so we emit depth-first and set each node's `prevSiblingId` to the
*previously-emitted sibling at its level* — never re-derived from the index. The only place existing tree
state is read is the **top-level anchor**, where the forest attaches among the parent's *existing*
children: that reuses `planAddNode`'s exact rule (`last` chains after the current last child, no repoint;
`first` inserts at the head and repoints the old first child to the run's tail). A future dev *will* reach
for "just loop the single-add planner" and reintroduce the tear; this is the single most important thing
the ADR records. Asserted as a test (multiple roots → one unbroken chain).

**Atomic all-or-nothing; no per-node recovery.** One `applyBatch` = one `transactionSync` = one sync frame
([ADR 0009](./0009-atomic-structural-writes.md)), so a bad `parentId`, an invalid `date`, an empty forest,
or an over-cap payload fails the *whole* call and nothing half-lands — matching `planReparent`. Rejected:
partial success ("added 8 of 12") — it leaves the agent reasoning about half-built state.

**Bounded at `MAX_BATCH_NODES = 500`, counted during `emit`.** Same number as `MAX_OUTLINE_NODES`, one
mental model ("500 is the ceiling everywhere") and already the count an agent hits reading back. Count is
the resource bound (one transaction, one frame); a 500-node cap bounds depth implicitly, so **no separate
depth cap**. Over the cap fails fast, naming the cap and the count received so the agent can split. Bulk
"import my whole outline" is explicitly not this tool's job.

**Optional `date` daily target reuses the daily-claim path; `parentId` + `date` is a hard error.** With
`date`, the handler runs the same atomic `claimDailyId` + `planEnsureDaily` the daily tools use, then
parents the forest under that day (appended as its last children — `position` is a `parentId`-path concept
and ignored here), directly killing the motivating 15-call incident in one call. Neither set → top level;
`parentId` set → under that node, a mirror parent redirecting through `trueSourceOf` so children hang off
the content node ([ADR 0022](./0022-node-mirrors.md)), matching every other planner. **Both set → fail
loud** ("pass `parentId` or `date`, not both") rather than silently pick one — ambiguity should make the
agent correct itself. Targeting is thus a strict union of the two existing patterns, no new semantics.

**Fresh nodes only: `{ text, isTask?, children? }`.** No `completed`/`collapsed`/`bookmark`, and firmly no
`mirrorOf` — mirroring is `mirror_node`/`mirror_to_today`'s job with its cycle guards, and letting a create
tool mint mirrors would bypass them and blur "new content" vs "reference." Empty `text` is allowed (legal
in the outline; the editor makes empty bullets constantly). Every authored node — all roots and all
descendants — is stamped with `origin` (agent provenance, [node-provenance](./0026-agent-native-mcp-server.md));
the daily container/day materialized by `planEnsureDaily` stay `null` (structural scaffolding the DO would
create anyway), the same split `planAddToDaily` already uses.

**`add_subtree` coexists with `add_node`; it does not replace it.** `add_subtree` is a strict superset (a
single bullet is a one-element `nodes` array), but collapsing to one tool would tax the ~95% single-bullet
capture case with array ceremony and break existing `add_node` callers. Two tools with a clean "one vs.
many/nested" split is *less* agent confusion than one over-general tool. The name is `add_subtree` (not
`add_nodes`) to avoid the one-character collision with `add_node` in a skimmed tool list and because
"subtree" *describes the shape* — the cue for when to reach for it.

**Pure twin, not a shared implementation.** `planAddSubtree` is new pure code in `worker/outline-ops.ts`,
anchored on `src/data/tree.ts` (`buildTreeIndex`/`childrenOf`/`trueSourceOf`/`makeNode`) like every other
planner, with ids/timestamps as arguments so `bun test` covers the chain surgery without a DO or clock
([ADR 0021](./0021-effect-first-one-schema-language.md)). There is no client counterpart to twin — the app
builds subtrees keystroke by keystroke — so this is the one planner without an in-app mirror.

## Considered and rejected

- **Flat `tempId` + `parentTempId` input** — recursion-free, but worse agent ergonomics and a new authoring
  error class; the recursion it avoids already publishes fine for our clients.
- **Indented-markdown string input** — one arg, but a parser with silent mis-nesting failure modes.
- **Looping `planAddNode`** per node — reintroduces the stale-index sibling-chain tear; the whole reason the
  planner wires links by construction.
- **Collapse `add_node` into `add_subtree`** (deprecate the single-add) — array ceremony on the common case,
  breaks existing callers.
- **`parentId` silently wins when both targets are set** — hides an agent mistake; hard reject makes it fix
  the call.
- **Per-node `completed`/`collapsed`/`mirrorOf`** — the first two are noise/view concerns an agent can set
  after; `mirrorOf` bypasses the mirror cycle guards. Additive later if a real workflow needs `completed`.
- **A separate depth cap** — node count is the real resource bound and caps depth implicitly.

## Consequences

- One new tool entry in `worker/mcp-tools.ts` (`add_subtree`) + the `planAddSubtree` planner in
  `worker/outline-ops.ts` (reusing the private `newNode`, `planAddNode`'s anchor rule, and
  `planEnsureDaily` for the `date` path); `tools/list` derives itself
  ([ADR 0026](./0026-agent-native-mcp-server.md)). The published tool count is now ten.
- Covered by `worker/outline-ops.test.ts` (the planner: multi-root chain integrity, deep nesting,
  first/last anchor against existing children, the daily-`date` ensure-and-append path, the node-count cap,
  and the empty-forest reject) plus the handler-level `parentId`+`date` and bad-`parentId` rejections. No
  new e2e — MCP has no browser caller, the same carve-out as the rest of the surface.
- No migration, no new `Node` field, no client change.
