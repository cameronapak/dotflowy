---
status: accepted
---

# Effect replaces errore

**Decision.** Effect's typed-error channel is dotflowy's single error model. The errore.org
`Error | T` convention is being phased out. This supersedes the earlier deliberate errore/Effect
**split** (errore at boundaries-we-own, Effect only at the `kv-client-effect.ts` pilot) — that split
was a transitional state, not the end state.

**Why.** One error model instead of two, and Effect already carries the load where it matters: the
Worker (`worker/index.ts`) is a full Effect pipeline (tagged errors, `catchTag`, `Effect.die` for
defects), and the kv side-collection transport core (`kv-client-effect.ts`) gets retry, an 8s
timeout, typed errors, and response-shape validation that the bespoke errore/fetch boundaries never
had. errore's `Error | T` unions buy flat control flow but no I/O robustness; Effect buys both.

**The throw-boundary exception (load-bearing).** TanStack DB mutation handlers signal failure by
**throwing** — a thrown `onInsert`/`onUpdate`/`onDelete` is what triggers optimistic rollback. So
`src/data/kv-api.ts` stays throw-shaped, but each function is now a thin **shell** that runs the
matching Effect program through `runPromise` (Effect-backed throw, not hand-rolled fetch). The throw
is a TanStack constraint, not an errore holdover; keeping it is not "keeping errore."

**Migration status.** Done for the runtime (2026-06-27): errore is fully removed from `src/` and
dropped from `package.json`. `errors.ts` (`BootstrapError`) now uses `Data.TaggedError`; the lone
`errore.try` in `realtime.ts` became a plain sync try/catch (a per-frame JSON.parse-or-null doesn't
warrant Effect's runtime). The value-as-error pattern survives where it fits — `bootstrapOutline`
still returns `BootstrapError | void` — it just uses an Effect error type now, not the errore library.

**Don't:** reach for errore (`Error | T`, `errore.try`, `createTaggedError`) in new or refactored
modules; convert the `kv-api.ts` throw-shells to return Effect values (TanStack needs a rejecting
promise); or reintroduce a bespoke `fetch` in those shells instead of delegating to the Effect core.
