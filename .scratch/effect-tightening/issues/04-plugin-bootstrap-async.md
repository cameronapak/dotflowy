# 04 — plugin + bootstrap async (Effect)

Status: Planned. Risk: LOW–MED. Depends on: nothing (parallel with 01–03).

See [PRD](../PRD.md). The scattered edge async the audit found. Independent of the write path, so it can
land anytime.

## Scope

- **`seed.ts` bootstrap → full Effect program.** `bootstrapOutline` already half-types failure
  (`BootstrapError`, `errors.ts`) but reaches it via `toArrayWhenReady().catch(e => new BootstrapError)`
  (`seed.ts:35`). Make it one Effect: lift the readiness wait, map failure to `BootstrapError` in the
  typed channel, keep the value-as-error return at its boundary (`Error | T`, checked by the caller).
  The boundary stays value-shaped (it's a mount-time check, not a TanStack handler) — Effect underneath.
- **`fetchLinkTitle` → Effect with fiber interruption** (`links/index.ts:115` + the fire-and-forget at
  `:225`). Today it's `void fetchLinkTitle().then(...)` with no cancellation, so a slow unfurl can write
  a title into a bullet's DOM **after that bullet was deleted** (a real write-after-free). Model the
  fetch as an interruptible Effect (`Effect.tryPromise` + the unfurl already has a Worker-side 5s cap);
  fork it tied to the node's lifetime and interrupt on unmount/delete. Keep the graceful-fallback (a
  failed/blocked fetch leaves the `[url](url)` placeholder, ADR 0016). This **fixes a bug**, not just
  style.
- **daily `ensure*` + `pending.ts` → Effect.** `ensureNodeExists`/`ensureContainer`/`ensureDay`
  (`daily/index.tsx:79–155`) are `async/await` + `.catch(() => {})` chains; `withDailyNavigation`
  (`pending.ts:36`) is a `try/finally` depth-counter. Convert to Effect programs; the `try/finally`
  becomes `Effect.ensuring`. **Keep using the low-level `mutations.ts` primitives directly**, not
  `ctx.mutations` (CLAUDE.md: navigate-away creates need different capture/focus semantics). Bridge at
  the click-handler seam with `runPromise`/`runFork`.

## Acceptance

- `fetchLinkTitle`: deleting a bullet mid-unfurl no longer writes its DOM (new e2e or a focused unit on
  the interruption seam). Successful unfurl still swaps the label; failure still leaves the placeholder.
- daily get-or-create still idempotent + self-healing (e2e `daily-notes.spec.ts` green, serial — watch
  the pre-existing parallel flake).
- bootstrap still seeds only a genuinely-empty outline (`seed.ts` behavior unchanged; e2e green).
- No raw `fetch`/`new Promise`/`try-catch`-for-an-effect left in these paths. typecheck/test/lint green.

## Watch-outs

- The daily `ensure*` capture/focus semantics are subtle (why it avoids `ctx.mutations`). Don't "tidy"
  that into `ctx.mutations` during the conversion.
- `assertTouchedChainsClean` (`structural.ts:79`) and `healSiblingChains` (`collection.ts:215`)
  try/catch blocks are **invariant tripwires / repair guards, not effects** — leave them as plain
  try/catch (ADR 0021: pure-ish guards aren't wrapped).
