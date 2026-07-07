# 39. An Effect-backed async seam for plugins (`ctx.run`)

## Status

Accepted.

## Context

The plugin contract (ADR 0001) is synchronous. `InputSpec.afterPaste` may do
async work but returns `void`; `PluginDef.preload` returns `void`. Every plugin
doing async work therefore re-derives its own execution + error + lifecycle
story. Two consumers exist today and they diverge:

- The links title-unfurl forks a fiber on the shared `appRuntime` — tracked, but
  app-scoped (never interrupted on editor teardown) and with no timeout.
- The daily get-or-create hand-rolls `async/await` Promise chains that never
  touch the shared runtime, and in one spot leaks an unhandled rejection.

The Effect runtime, typed errors, retry, and timeout are already the house model
for I/O (ADR 0012, `kv-client-effect.ts`). What is missing is a way for a plugin
to run async work *through* that model without re-implementing forking, fiber
tracking, interruption, and a failure sink each time.

## Decision

Add one capability to `PluginContext`:

    run(effect: Effect.Effect<unknown, unknown>): void

`run` forks the effect on the shared `appRuntime`, registers the fiber in an
editor-scoped set, removes it from the set on completion, and interrupts every
still-running fiber when the editor unmounts. Before forking it wraps the effect
with a failure sink (`catchCause` → log) so a defect or unhandled failure is
logged, never silently swallowed and never a floating unhandled rejection.

The seam owns the *runtime, lifecycle, and failure logging* — not error
*semantics*. A plugin still composes its own timeout/retry/typed-error recovery
inside the effect it hands to `run` (the kv core is the pattern). The effect must
be fully provided (`R = never`, satisfied by `appRuntime`'s layer) and should be
`Effect<void>` at the point of `run` (self-handle the domain result).

## Consequences

- Plugin async work is robust by construction: one runtime, guaranteed failure
  logging, guaranteed interruption on editor teardown.
- `PluginContext` grows a versioned capability (as its doc-comment anticipates).
  There is exactly one constructor of `PluginContext` (the editor's `pluginCtx`),
  so the surface stays centrally owned.
- **Scope is editor-lifetime, not node-lifetime.** Deleting a single node does
  not interrupt a `run` in flight — the continuation's own guards (e.g. the
  unfurl's `current == null` / verbatim-match checks) still handle a
  since-deleted target. Node-scoped cancellation is deliberately not built (it
  would require per-node fiber tracking for a rare case the guards already cover).
- **A promise lifted with `Effect.promise` is not truly cancellable.**
  Interrupting the fiber stops the continuation but cannot abort the underlying
  JS promise (it has no signal). Effects built from `Effect.tryPromise` with the
  runtime `signal` threaded to `fetch` (the unfurl) DO get real cancellation. The
  daily migration uses the promise-lift form and therefore gets lifecycle
  tracking + failure logging, but not fetch abortion — acceptable, and recorded
  here so the difference is not mistaken for a bug.

## Alternatives considered

- **Let plugins call `appRuntime.runFork` themselves** (status quo for links):
  rejected — every plugin then re-implements tracking, interruption, and a
  failure sink, and most will skip them (daily did).
- **A typed-error `run` (`Effect<void, never>`)** forcing the plugin to pre-handle
  all errors: rejected as needlessly restrictive; the failure sink makes an
  escaped error observable without forcing the plugin to prove `never`.
- **Node-scoped fibers**: rejected — disproportionate for the one case
  (unfurl-after-delete) the continuation guards already cover.

## Implementation note (Effect v4)

Effect v4 (vendored at `repos/effect-smol/`) renamed `Effect.catchAllCause` to
`Effect.catchCause`; `Fiber.RuntimeFiber` no longer exists as a separate type —
`ManagedRuntime.runFork` returns `Fiber.Fiber<A, E>`. The implementation follows
the vendored source, not the v3-era names.
