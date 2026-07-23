# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

Dual-path e2e + product fixes landed. Client flag **still default OFF**. Live authenticated socket, manual migration, and loading smoke pass; MCP's Lunora routing remains code-verified but needs an OAuth bearer + paid local entitlement for a live `tools/call`.

## Flag — Lunora outline sync (client)

|             |                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------- |
| **Name**    | `dotflowy:flag:lunora-sync`                                                                     |
| **Getter**  | `isLunoraSyncEnabled()` in `src/data/flags.ts`                                                  |
| **Default** | **OFF** (do not flip until checklist below)                                                     |
| **Enable**  | `localStorage.setItem("dotflowy:flag:lunora-sync", "on")` then reload, **or** `?lunora-sync=on` |
| **Disable** | `"off"` in localStorage, or `?lunora-sync=off`                                                  |

## Flag — Lunora MCP store (Worker)

|             |                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------- |
| **Name**    | `LUNORA_OUTLINE`                                                                         |
| **Default** | **OFF** (unset in `.dev.vars.example` still documents the opt-in; do not default to `1`) |
| **Enable**  | `LUNORA_OUTLINE=1` in `.dev.vars`                                                        |

## Default-ON readiness — **NO**

| Gate                            | Result                           |
| ------------------------------- | -------------------------------- |
| typecheck* / lint / bun test    | GREEN                            |
| `e2e/lunora-*.spec.ts`          | GREEN (5/5)                      |
| Classic subset `E2E_LUNORA=1`   | Broader matrix GREEN (see below) |
| Dogfood migrate (`bun run dev`) | **PASS** (2026-07-23; see below) |

Keep default OFF.

## e2e Lunora run matrix (this slice)

```sh
export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"
# Dedicated
bunx playwright test e2e/lunora-*.spec.ts --workers=1
# Broader classic dual-path (nearly full e2e/)
E2E_LUNORA=1 E2E_PORT=3231 bunx playwright test e2e --workers=1
```

**Last broader matrix** (`E2E_LUNORA=1 E2E_PORT=3231 bunx playwright test e2e --workers=1`):
**355 passed / 1 flaked / 13 skipped**. Flake was `lunora-structural` `/delete`
reload racing fire-and-forget watermark — hardened to await `mutators:removeNode`
(repeat-each green). Prior full run before fixes: **350 / 15 / 4**.

Product fixes that cleared the 15: Lunora big-delete → `mutators.removeMany`;
keymap delete passes `instanceId` (mirror instance, not source).

| Spec / area                                           | Under `E2E_LUNORA=1`                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| Dedicated `lunora-*.spec.ts`                          | PASS                                                          |
| Nearly full classic `e2e/*.spec.ts`                   | PASS (product gaps fixed below)                               |
| daily-notes: claim-race (`?op=claim` override)        | **SKIP** — classic `/api/kv` transport only (`isE2eLunora()`) |
| atomic-structural-writes (`/api/nodes` batch asserts) | **SKIP** — classic wire only                                  |
| changelog cursor seed/write asserts                   | **SKIP** — classic `/api/kv` mock                             |
| drag-filtered structural POST await                   | **SKIP** — awaits classic `/api/nodes`                        |
| opml multi-slice "one atomic batch" progress copy     | **SKIP** — classic transport progress state                   |
| save-failure structural fail injection                | **SKIP** — classic structural transport                       |
| sibling-chain-repair malformed snapshot               | **SKIP** — classic snapshot fixture                           |
| update-available `serverVersion` handshake            | **SKIP** — classic sync handshake                             |

### Fixture dual-path

- `seedOutline(..., { lunora?: boolean })` **or** `E2E_LUNORA=1` → `seedOutlineLunora`
- Mock: per-shape checkpoints + **delete ops in pokes** (put-only resurrected deletes)
- `page.unroute("**/_lunora/**")` etc. at seed start (reload / stacked-handler flake)
- AuthGate session mock kept on Lunora path

### Product fixes this slice

- `src/data/live-nodes.ts` — event-time reads for selection / paste / daily migration
- daily `get-or-create.ts` uses `getLiveNodes()` (scaffold migrate saw empty classic collection)
- Cmd+K: run action before close; `onDeleteNode` prefers explicit target id
- markdown-paste Lunora `restoreNodes` path
- big-delete confirm: Lunora path uses `mutators.removeMany` (not classic sliced `{ops}`)
- bullet keymap delete: pass `instanceId` so mirrors delete the instance, not the source

## Dogfood live smoke — **PASS (connection + loading + migration)**

`vite.config.ts` sets `ws: true` for both `/api` and `/_lunora`; the old string shorthand silently dropped WebSocket upgrades.

Live probe on `bun run dev` (`dev@dotflowy.local` / `dotflowy-dev`):

1. Better Auth sign-in through Vite (`:3000`) returned **200** and set `better-auth.session_token`; `GET /api/auth/get-session` resolved user `VkBqJpDMdmTnAxjsqeOw4SH0cVST2weX`.
2. Cookie-authenticated `/_lunora/ws?shard=<userId>` with `Origin: http://localhost:3000` returned **101** through both Vite (`:3000`) and direct Wrangler (`:8787`). The raw curl clients timed out after upgrading, as expected for an idle WebSocket.
3. Browser smoke with `dotflowy:flag:lunora-sync=on` rendered the Lunora outline and **cleared "Loading outline"**.
4. Fresh run: flag OFF classic source held 3 welcome nodes. Flag ON exposed `window.__dotflowyMigrateToLunora` as a function and cleared loading. After clearing prior local Lunora spike seed rows, the empty shard auto-imported the three classic nodes; the concurrent manual helper then safely returned `skipped-nonempty` with `nodes: 3`. A full reload retained all three classic titles. More menu also displayed its safe-skip toast against a nonempty shard.

**Keep default OFF.** Migration + dual-path e2e + MCP Lunora live write are dogfood-verified; default ON still waits on optional browser re-check + broader recount.

## Dogfood MCP with `LUNORA_OUTLINE=1` — **PASS (live write, 2026-07-23)**

1. Local-only `.dev.vars` has `LUNORA_OUTLINE=1`; `bun run dev` restarted; Wrangler lists `env.LUNORA_OUTLINE`.
2. **Entitlement:** `bun run comp:dev-plan` hand-inserts an `active` `unlimited` row in local D1 for `dev@dotflowy.local` (`referenceId = VkBqJpDMdmTnAxjsqeOw4SH0cVST2weX`). Idempotent; no production gate changes.
3. **Auth:** `bun run mint:mcp-token` runs dynamic registration + PKCE against `http://localhost:8787/api/auth/mcp/*` and prints a real bearer (`auth.api.getMcpSession`-valid).
4. **Live write proof** (with `LUNORA_OUTLINE=1`, comped plan, minted bearer):

```sh
bun run comp:dev-plan
TOKEN=$(bun run mint:mcp-token 2>/dev/null | rg '^access_token:' | cut -d' ' -f2)
# tools/call add_node
curl -s -X POST http://localhost:8787/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_node","arguments":{"text":"MCP-LUNORA-PASS-1784839995"}}}'
# → {"result":{"content":[{"type":"text","text":"Added \"MCP-LUNORA-PASS-1784839995\" at the top level (id: d4659316-091a-462f-9274-0c8dc29aade5)."}]}}
# tools/call search_nodes
curl -s -X POST http://localhost:8787/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_nodes","arguments":{"query":"MCP-LUNORA-PASS-1784839995"}}}'
# → {"result":{"content":[{"type":"text","text":"- \"MCP-LUNORA-PASS-1784839995\" (id: d4659316-091a-462f-9274-0c8dc29aade5)"}]}}
# tools/call get_outline (Lunora shard via createLunoraOutlineStore → mcp:listNodes)
curl -s -X POST http://localhost:8787/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_outline","arguments":{}}}'
# → outline text includes the new bullet id d4659316-091a-462f-9274-0c8dc29aade5
```

5. Pre-comp control: same bearer without subscription row got JSON-RPC `-32001` upgrade required on `tools/call` (entitlement gate intact).
6. Browser with `dotflowy:flag:lunora-sync=on` not re-run this slice — MCP readback confirms the Lunora SHARD mutation (same `userId` shard key as browser mutators). Optional follow-up: reload editor and confirm the marker bullet renders.

**Scripts (committed):** `scripts/comp-dev-plan.ts`, `scripts/mint-mcp-token.ts` → `bun run comp:dev-plan`, `bun run mint:mcp-token`.

## Known gaps → flag-default-ON checklist

1. ~~Dual-path fixture + representative classic subset~~ **DONE** (this slice)
2. ~~Manual migration dogfood~~ **DONE** (2026-07-23)
3. ~~**MCP live write dogfood** with `LUNORA_OUTLINE=1`~~ **DONE** (2026-07-23; see above)
4. ~~Broader classic specs under `E2E_LUNORA=1`~~ **DONE** (transport-only skips; product gaps fixed)
5. Optional: re-run full `E2E_LUNORA=1 bunx playwright test e2e` for a clean green count (expect ~359 pass / ~13 skip)
6. Snapshot/R2/PITR still classic DO — out of scope
7. Flip client default ON + `.dev.vars.example` `LUNORA_OUTLINE=1` only after 3 green

## Gates

```sh
bun run typecheck && bun run typecheck:worker && bun run typecheck:test
bun run lint && bun run test
bunx playwright test e2e/lunora-*.spec.ts
E2E_LUNORA=1 bunx playwright test <subset> --workers=1
```

## Next

1. Optional: browser reload with `dotflowy:flag:lunora-sync=on` to visually confirm MCP-written bullets.
2. Optional clean full-suite recount under `E2E_LUNORA=1`.
3. Then consider default ON → PR; **delete `HANDOFF.md` in shipping PR.**
