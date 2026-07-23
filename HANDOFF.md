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

**Last broader matrix:** first full run **350 passed / 15 failed / 4 skipped**.
Focused regression re-run after product fixes + classic-wire skips:
**18 passed / 9 skipped / 0 failed**. Big-delete, sliced history restore, and
mirror-instance delete are green; the nine skips are classic-transport-only.

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

**Keep default OFF.** Migration is now dogfood-verified, but MCP live writes and broader dual-path coverage still gate default ON.

## Dogfood MCP with `LUNORA_OUTLINE=1` — **PARTIAL / auth-blocked**

1. Local-only `.dev.vars` has `LUNORA_OUTLINE=1`; `bun run dev` was restarted and Wrangler listed `env.LUNORA_OUTLINE`.
2. `POST http://localhost:8787/mcp` JSON-RPC `initialize` correctly returned `401` with local protected-resource metadata.
3. Code path verified: `worker/index.ts` selects `createLunoraOutlineStore(env, token.userId)` when the flag is truthy; `worker/lunora-mcp-store.ts` dispatches writes to `mcp:applyChangeOps` on the authenticated user's `SHARD`.
4. No local OAuth bearer was minted: the endpoint requires Better Auth MCP OAuth dynamic registration + PKCE, and MCP tool calls additionally require a paid entitlement. No existing local MCP test client/admin token shortcut was found. Therefore no authenticated live `tools/call` has run yet.

## Known gaps → flag-default-ON checklist

1. ~~Dual-path fixture + representative classic subset~~ **DONE** (this slice)
2. ~~Manual migration dogfood~~ **DONE** (2026-07-23)
3. **MCP live write dogfood** with `LUNORA_OUTLINE=1` — mint local OAuth bearer for an entitled test user, then call a write tool and observe the Lunora editor update
4. Remaining classic specs under `E2E_LUNORA=1` (full suite) — maximize; skip only transport-bound specs
5. Snapshot/R2/PITR still classic DO — out of scope
6. Flip client default ON + `.dev.vars.example` `LUNORA_OUTLINE=1` only after 3–4 green

## Gates

```sh
bun run typecheck && bun run typecheck:worker && bun run typecheck:test
bun run lint && bun run test
bunx playwright test e2e/lunora-*.spec.ts
E2E_LUNORA=1 bunx playwright test <subset> --workers=1
```

## Next

1. Mint an OAuth bearer for a locally entitled test user, exercise an MCP write with `LUNORA_OUTLINE=1`, and observe it in the Lunora editor.
2. Broader `E2E_LUNORA=1` classic suite; document remaining fails.
3. Then consider default ON → PR; **delete `HANDOFF.md` in shipping PR.**
