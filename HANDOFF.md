# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

Dual-path e2e + product fixes landed. Client flag **still default OFF**. Not ready to flip default ON — dogfood migrate blocked; a few classic specs stay Lunora-incompatible (skipped).

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

| Gate                            | Result                         |
| ------------------------------- | ------------------------------ |
| typecheck* / lint / bun test    | GREEN                          |
| `e2e/lunora-*.spec.ts`          | GREEN (5/5)                    |
| Classic subset `E2E_LUNORA=1`   | Mostly GREEN (see matrix)      |
| Dogfood migrate (`bun run dev`) | **FAIL / blocked** (see below) |

Keep default OFF.

## e2e Lunora run matrix (this slice)

```sh
export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"
# Dedicated
bunx playwright test e2e/lunora-*.spec.ts --workers=1
# Classic dual-path
E2E_LUNORA=1 E2E_PORT=3225 bunx playwright test \
  e2e/enter-split.spec.ts e2e/delete-command.spec.ts e2e/collapse-flash.spec.ts \
  e2e/markdown-paste.spec.ts e2e/node-multi-select.spec.ts e2e/mirrors.spec.ts \
  e2e/command-center.spec.ts e2e/emphasis.spec.ts e2e/daily-notes.spec.ts \
  e2e/quick-add.spec.ts e2e/paragraph.spec.ts e2e/move-flash.spec.ts \
  e2e/lunora-*.spec.ts e2e/atomic-structural-writes.spec.ts \
  --workers=1
```

**Last matrix:** **132 passed / 4 skipped / 1 flake fixed after** (reload pollution) → expect **~136 pass / 4 skip** after `page.unroute` fix.

| Spec / area                                             | Under `E2E_LUNORA=1`                                          |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| Dedicated `lunora-*.spec.ts`                            | PASS                                                          |
| enter-split, delete-command, collapse-flash, move-flash | PASS                                                          |
| markdown-paste, mirrors, emphasis, paragraph            | PASS                                                          |
| node-multi-select, command-center, quick-add            | PASS                                                          |
| daily-notes (most)                                      | PASS — orphan kv + ADR 0052 migrate fixed via `getLiveNodes`  |
| daily-notes: claim-race (`?op=claim` override)          | **SKIP** — classic `/api/kv` transport only (`isE2eLunora()`) |
| atomic-structural-writes (`/api/nodes` batch asserts)   | **SKIP** — classic wire only                                  |

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

## Dogfood migrate smoke — **FAIL / blocked**

Attempted `bun run dev` + agent-browser (`dev@dotflowy.local` / seed:user):

1. Sign-in OK.
2. With `dotflowy:flag:lunora-sync=on`, UI stuck on **"Loading outline"**; wrangler showed **no** `/_lunora/ws` upgrade (only stray `GET /_lunora/ 404`).
3. Classic path for same account also showed **0 bullets** (empty shell) — unclear if seed/sync/email-verify quirk.

**Not a fixture issue** — live Worker Lunora handshake needs a follow-up spike before default-ON. Re-run dogfood after `/_lunora/ws` connects in `bun run dev`.

## Known gaps → flag-default-ON checklist

1. ~~Dual-path fixture + representative classic subset~~ **DONE** (this slice)
2. **Dogfood migrate** live — still blocked (above)
3. **MCP dogfood** with `LUNORA_OUTLINE=1`
4. Remaining classic specs under `E2E_LUNORA=1` (full suite) — maximize; skip only transport-bound specs
5. Snapshot/R2/PITR still classic DO — out of scope
6. Flip client default ON + `.dev.vars.example` `LUNORA_OUTLINE=1` only after 2–4 green

## Gates

```sh
bun run typecheck && bun run typecheck:worker && bun run typecheck:test
bun run lint && bun run test
bunx playwright test e2e/lunora-*.spec.ts
E2E_LUNORA=1 bunx playwright test <subset> --workers=1
```

## Next

1. Fix live `/_lunora/ws` dogfood hang; re-run migrate smoke → PASS in this file.
2. Broader `E2E_LUNORA=1` classic suite; document remaining fails.
3. Then consider default ON → PR; **delete `HANDOFF.md` in shipping PR.**
