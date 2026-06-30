# 04 — plugin + bootstrap async (Effect)

Status: CLOSED — bootstrap (part 1) + links unfurl (part 2) BUILT + green. Daily `ensure*` (part 3)
DEFERRED, accepted by Cam 2026-06-30 (keep as-is; revisit only if the daily flow is touched for another
reason). Evidence in "Part 3" below. Risk: LOW–MED. Depends on: nothing (parallel with 01–03).

Built:
- **`seed.ts` bootstrap → Effect.** `bootstrapOutline` is one `Effect` program: `tryPromise` over the
  readiness wait, a typed `BootstrapError` gate on `nodesLoadError`, `seedIfEmpty` in the success leg;
  `Effect.match` folds the typed failure back to a VALUE (`BootstrapError | void`) at the mount-time
  boundary the caller checks (not a throw — not a TanStack handler). Behavior identical.
- **`fetchLinkTitle` → `fetchLinkTitleE` + `appRuntime.runFork`** (`links/index.ts`). The unfurl is now
  an Effect (`tryPromise` with the runtime `signal` → interruptible; `orElseSucceed(null)` keeps the
  graceful fallback), and the afterPaste fire-and-forget is a managed fiber, not a floating promise. The
  existing guards (`current == null`, verbatim `swapLinkLabel`) are kept.

Gates: typecheck + typecheck:test + lint clean, unit 134/134, e2e rich-links 11/11 serial (incl. the
title-swap + failed-fetch-fallback). The "write-after-delete" the plan billed was ALREADY guarded by
`current == null` + verbatim-match, so part 2 is ADR-0021 alignment + a managed/interruptible fiber, NOT
a critical bug fix (honest correction of the plan's framing).

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

## Part 3 (daily `ensure*` + `pending.ts`) — recommended defer, with evidence

`ensureNodeExists`/`ensureContainer`/`ensureDay`/`getOrCreateDay` (`daily/index.tsx`) +
`withDailyNavigation` (`pending.ts`) are `async/await` glue around `claimMapping` (already Effect-backed),
`runStructural` (sync), and `setMapping` (sync). Converting them is a CASCADE through ~5 functions + 3
bridge sites (`goToDate`, the `/` command, the Cmd+K Seam-J action), in the **subtlest async in the
codebase** (atomic claim, idempotency, self-heal, the deliberate `mutations.ts`-not-`ctx.mutations`
capture/focus semantics), behind a **known-flaky e2e** (`daily-notes.spec.ts`).

The genuine effects there are small: `withDailyNavigation`'s `try/finally` → `Effect.ensuring`, and
`ensureNodeExists`'s `await waitForNode(...).catch(() => {})` → compose the issue-03 `waitForNodeE`. The
rest is correct, readable async orchestration with no retry/timeout/concurrency/resource benefit — and
ADR 0021's own test ("if the code already makes the call obvious, the code is the doc; don't churn it").
So: net LOW value, MED risk in fragile code. Recommend leaving it unless the daily flow is being touched
for another reason — at which point the `waitForNodeE` compose + `ensuring` ride along cheaply.

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
