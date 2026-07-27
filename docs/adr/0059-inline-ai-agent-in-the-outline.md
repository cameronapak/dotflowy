# Inline AI agent in the outline (Lunora-native)

Tag `@agent` or `@dot` in a bullet, fire with `Mod+Shift+Enter` or `/ask`, and
the answer lands as **real child nodes you own** — not a chat sidebar. Execution
is **server-side on Lunora** (ADR 0058): a `runs` shard table + durable
action/workflow tool loop, writes through the same authoritative mutators MCP
uses. Classic-DO accounts get the feature when they opt into upgraded sync.

## Why Lunora-native (v1 → v2)

An earlier draft homed runs in the classic per-user DO (`runs` SQL, `activeRuns`
on snapshot/resume, ephemeral `/api/sync` frames, commit via `applyBatch`). That
is on ADR 0058's demolition list (sequence step 5 deletes the custom changelog
sync), and Cam's own account already runs Lunora — so a classic-only engine
would not work for the person building it. Rejected.

## Locked product decisions

| Area             | Decision                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answer placement | Always a **child** of the fired node (never sibling).                                                                                                                                                                                                                                                                                                                   |
| Volume           | One-line **summary** child; when detail exists the summary arrives `collapsed: true` (detail hidden until expand). Nested detail parents also arrive collapsed.                                                                                                                                                                                                         |
| Search           | Fully searchable/filterable. Nothing hidden from search.                                                                                                                                                                                                                                                                                                                |
| Cleanup          | No accept/strip. The `@agent` / `@dot` chip stays forever (provenance on a line you authored).                                                                                                                                                                                                                                                                          |
| Filter           | New Seam-K `is:ai` = `@agent`/`@dot` mention in `node.text` **OR** `origin` set. Distinct from shipped `is:agent` (origin-only).                                                                                                                                                                                                                                        |
| Mentions         | `@agent` and `@dot` are interchangeable. Chip chrome: Dot avatar + mention pill + trailing play/stop. Theme-aware SVG identity only (no face animation).                                                                                                                                                                                                                |
| Opt-in           | Synced Settings **Inline agent (BETA)** toggle (`account-prefs` / `inline-agent-beta`), default OFF. Interactive only when upgraded sync is ON (else disabled + needs-sync hint). Free users see the row as upgrade bait; toggling ON deep-links Plan & billing. Client fire paths also gate on the pref; server `getPlan` fail-closes. User copy must not name Lunora. |
| Run state        | Lunora `runs` table (`.shardBy("userId").ownedBy("userId")`) + live shape subscription. No new classic sync frames.                                                                                                                                                                                                                                                     |
| Streaming        | Partial tokens → Lunora realtime when WS is healthy (future: ghost sibling of `.node-text`). v1 busy UI is **trailing chrome** (loader + Stop), not under-row ghost. Completion commits the answer tree in **one mutator transaction**; clients may soft-reload + animate-in when WS poke is missed.                                                                    |
| Discard / undo   | Re-fire replaces (or appends — see replace guard). Cmd+Z does **not** undo server-originated answers (same as MCP today).                                                                                                                                                                                                                                               |
| Replace guard    | Re-fire replaces only if the prior answer subtree is untouched (hash/snapshot on the run). Touched → append after it.                                                                                                                                                                                                                                                   |
| Tools            | Read + additive only (`get_outline`, `search_nodes`, `export_opml`, `add_node`, `add_subtree`, `add_to_today`, `mirror_node`, `mirror_to_today`). Denied: `update_node`, `delete_node`, `move_nodes`, `import_opml`. Engine re-fire replace is not a model tool.                                                                                                        |
| Firing           | **Trailing circular play** + `Mod+Shift+Enter` → Run confirm popover (two-step, anti-accident). `/ask` (**Ask Dot**) only tags `@dot` — does **not** open the popover or fire; user presses play when ready. Play stays whenever fireable. While `running`: play becomes **Stop**; shadcn **BrailleLoader** (`breathe` default) beside Stop. Quick-add excluded in v1.  |
| Continuation     | No conversation object. Follow-up = new `@agent`/`@dot` sibling. Prompt = prior turns (mention siblings + their answer subtrees) + one labeled untrusted context block.                                                                                                                                                                                                 |
| Billing          | Paid plans only (`getPlan`). Free for paid users while in beta. Prefer AI Gateway in front of Workers AI in prod (`LUNORA_AI_GATEWAY_*`); direct Workers AI is fine for local/dev when unset.                                                                                                                                                                           |
| Schema           | **No new `Node` field.** Zero wire/migration/`e2e/fixtures`/R2 snapshot risk.                                                                                                                                                                                                                                                                                           |

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

- Client: `src/plugins/agent/` — Seams A (`@agent`/`@dot` widget: Dot avatar +
  pill + trailing play/stop/loader), B (play → Run popover; stop → cancel),
  C (`/ask`), D (`Mod+Shift+Enter`), H (`@` picker), K (`is:ai`). Loader:
  shadcn BrailleLoader (`src/components/ui/braille-loader.tsx` +
  `src/lib/braille-loader.ts`; registry
  `https://shadcn-braille-loader.vercel.app/`).
- Settings: synced `account-prefs` row `inline-agent-beta` (default OFF), gated
  on upgraded sync + paid plan (client upgrade bait; server `getPlan`).
- Core: answer arrive animation after soft-reload; ghost text sibling reserved
  for future live `partialText` (not the v1 busy affordance).
- Lunora: `runs` table + mutators + run engine action/workflow.
- Pure logic (unit-tested): mention parse, `is:ai` predicate, tool allowlist,
  replace-guard hash, turn/context prompt rebuild.

## Consequences

- Feature is a **beta perk of upgraded sync** — classic accounts see the chip
  but cannot fire until they opt in (degrade cleanly; flag OFF is cold per ADR
  0058). A second Settings toggle (Inline agent BETA) must also be ON.
- `origin` does double duty: provenance sparkle + agent-turn attribution at
  prompt build (MCP-created nodes inside an answer subtree also read as agent
  turns — accepted). Sparkle on **every** agent-origin node (summary + detail).
- No classic sync protocol surface to port or delete at cutover.
- Sequential fire throttle is durable: Lunora `createDbStore` on
  `ratelimit_buckets`, with patch/delete scoped via `expectedTable` so the
  shard avoids unscoped `UNION ALL` id lookup (Workerd SQLite
  compound-SELECT limit; `asId` is a TS brand only and does not scope).
  Paid gate + `MAX_CONCURRENT_RUNS` still bound concurrent abuse.

## Follow-ups

Pinned fast-follows (not in this PR):

1. **Stream answer text** via throttle/debounce partial writes and/or a ghost
   sibling of `.node-text` (v1 commits the answer tree in one mutator
   transaction; busy UI is trailing BrailleLoader + Stop only).
2. **Allow `move_nodes`** for MCP + the inline agent (currently denied with
   `update_node` / `delete_node` / `import_opml`). Structural safety blast
   radius — needs a dedicated design pass before widening the allowlist.
3. **Tool mentions** in the question bullet to steer which tools the agent may
   use (beyond today's fixed read + additive allowlist).
