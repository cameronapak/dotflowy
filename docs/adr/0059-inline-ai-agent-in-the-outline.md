# Inline AI agent in the outline (Lunora-native)

Tag `@agent` in a bullet, fire with `Mod+Shift+Enter` or `/ask`, and the answer
lands as **real child nodes you own** — not a chat sidebar. Execution is
**server-side on Lunora** (ADR 0058): a `runs` shard table + durable
action/workflow tool loop, writes through the same authoritative mutators MCP
uses. Classic-DO accounts get the feature when they opt into upgraded sync.

## Why Lunora-native (v1 → v2)

An earlier draft homed runs in the classic per-user DO (`runs` SQL, `activeRuns`
on snapshot/resume, ephemeral `/api/sync` frames, commit via `applyBatch`). That
is on ADR 0058's demolition list (sequence step 5 deletes the custom changelog
sync), and Cam's own account already runs Lunora — so a classic-only engine
would not work for the person building it. Rejected.

## Locked product decisions

| Area             | Decision                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answer placement | Always a **child** of the fired node (never sibling).                                                                                                                                                                                                            |
| Volume           | One-line **summary** child; detail as **grandchildren** arriving `collapsed: true`.                                                                                                                                                                              |
| Search           | Fully searchable/filterable. Nothing hidden from search.                                                                                                                                                                                                         |
| Cleanup          | No accept/strip. The `@agent` chip stays forever (provenance on a line you authored).                                                                                                                                                                            |
| Filter           | New Seam-K `is:ai` = `@agent` mention in `node.text` **OR** `origin` set. Distinct from shipped `is:agent` (origin-only).                                                                                                                                        |
| Run state        | Lunora `runs` table (`.shardBy("userId").ownedBy("userId")`) + live shape subscription. No new classic sync frames.                                                                                                                                              |
| Streaming        | Partial tokens → subscribed clients via Lunora realtime; UI paints **ghost text** as a sibling of `.node-text` in `RowChrome` (never inside contentEditable). Completion commits the answer tree in **one mutator transaction**.                                 |
| Discard / undo   | Re-fire replaces (or appends — see replace guard). Cmd+Z does **not** undo server-originated answers (same as MCP today).                                                                                                                                        |
| Replace guard    | Re-fire replaces only if the prior answer subtree is untouched (hash/snapshot on the run). Touched → append after it.                                                                                                                                            |
| Tools            | Read + additive only (`get_outline`, `search_nodes`, `export_opml`, `add_node`, `add_subtree`, `add_to_today`, `mirror_node`, `mirror_to_today`). Denied: `update_node`, `delete_node`, `move_nodes`, `import_opml`. Engine re-fire replace is not a model tool. |
| Firing           | `Mod+Shift+Enter` (row + zoomed title keymaps) + `/ask` + chip Run popover (two-step fire / one-tap stop). Quick-add `MiniNodeEditor` excluded in v1.                                                                                                            |
| Continuation     | No conversation object. Follow-up = new `@agent` sibling. Prompt = prior turns (mention siblings + their answer subtrees) + one labeled untrusted context block.                                                                                                 |
| Billing          | Paid plans only (`getPlan`). Free for paid users while in beta. AI Gateway in front of Workers AI.                                                                                                                                                               |
| Schema           | **No new `Node` field.** Zero wire/migration/`e2e/fixtures`/R2 snapshot risk.                                                                                                                                                                                    |

## Lunora streaming / tool-loop gate (closed 2026-07-26)

Verified against installed packages (`@lunora/agent@1.0.0-alpha.14`,
`@lunora/ai`, `@lunora/workflow`) and their READMEs / `.d.ts`:

1. **Long-running tool loop:** `defineAgent` compiles a replay-safe tool loop
   onto Cloudflare Workflows (each LLM turn + tool call = named durable step).
   Plain actions also exist; workflows clear the ~10-minute action ceiling.
2. **Partial tokens to clients:** agent token sink tees streamed deltas onto
   Lunora's stream transport; clients observe via `useSubscription` (or
   high-frequency patches on a `runs` row for ghost text).
3. **Cancel:** `ctx.agents.*.cancel` patches thread status; if we stay on a
   custom `runs` table, stop is **cooperative** (status check between tool-loop
   steps) — Cloudflare Workflow cancel may also be available via the binding.

**Build choice:** keep the handoff's custom `runs` table (outline-native ghost
text + replace-guard hash + answer-as-nodes), implemented as a Lunora
action/workflow over `@lunora/ai` (`streamText` / `generateText`) + shared
outline mutators. `@lunora/agent`'s chat-thread tables are a considered option
for a future chat surface, not the v1 outline answer path.

## Home

- Client: `src/plugins/agent/` — Seams A (`@agent` token), B (chip popover/stop),
  C (`/ask`), D (`Mod+Shift+Enter`), H (`@` picker), K (`is:ai`).
- Core: ghost text sibling in `RowChrome` / zoomed title.
- Lunora: `runs` table + mutators + run engine action/workflow.
- Pure logic (unit-tested): mention parse, `is:ai` predicate, tool allowlist,
  replace-guard hash, turn/context prompt rebuild.

## Consequences

- Feature is a **beta perk of upgraded sync** — classic accounts see the chip
  but cannot fire until they opt in (degrade cleanly; flag OFF is cold per ADR
  0058).
- `origin` does double duty: provenance sparkle + agent-turn attribution at
  prompt build (MCP-created nodes inside an answer subtree also read as agent
  turns — accepted).
- No classic sync protocol surface to port or delete at cutover.
