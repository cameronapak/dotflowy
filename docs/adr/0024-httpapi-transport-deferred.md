---
status: proposed
---

# HttpApi/HttpApiClient as the one transport contract (deferred direction)

**Decision.** Modelling the whole `/api/*` surface as an Effect `HttpApi` — one schema-defined contract
that derives *both* a typed `HttpApiClient` (replacing the hand-written `src/data/kv-client-effect.ts` +
`src/data/nodes-client-effect.ts`) *and* the Worker's server handlers (replacing the hand-routing in
`worker/index.ts`) — is a **direction we endorse but are NOT building yet**. This ADR captures the intent,
the payoff, the unproven blocker, and the gate that would let us commit, so the idea isn't lost.

**Why it's attractive.** Today three things are hand-kept in lockstep: the Worker's manual routing +
`json()` + status mapping, the two client Effect fetch clients, and (until [ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)
/ the shared wire schema) the wire types. `HttpApi` collapses that to one source: `HttpApiClient` gives a
derived, typed client with a schema-based `urlBuilder`; `HttpApiSecurity.http` models the Better Auth
session gate; and **`HttpApiTest`** exercises handlers with no running server — a test tier the current
`seedOutline` mock (which fakes the Worker in-memory and never runs `worker/index.ts`) can't reach.

**Why it's deferred, not done.** Two reasons, and the bar is higher than for the work shipped alongside it
(the shared wire schema and the native DO hardening are *documented debt*; this is a speculative "better"):

- **`HttpApiClient` replaces the transport verb, not the value-add.** The client's hard parts are
  `Semaphore`-coalesced field edits (`src/data/api.ts`), the echo-hold via `waitForSeqE`
  (`src/data/structural.ts` + `collection.ts`), and the custom `Stream` sync socket (ADR 0013). None of
  those are HTTP request/response shaped, so `HttpApiClient` wouldn't touch them — we'd rewrite the
  plumbing and still hand-wire the hard parts. A partial win for a large churn.
- **The Worker-`fetch` adapter is unproven.** `HttpApi`'s server adapters target Node/Bun `HttpServer`.
  Ours is a Cloudflare Worker `fetch` export routed through per-user Durable Object stubs. Whether
  `HttpApi` cleanly drives a Worker `fetch` handler (not an `HttpServer`) is untested — the same
  prove-don't-assume discipline that validated the shared wire schema's cross-tsconfig import applies here.

**The gate to promote this to `accepted`.** A spike that (1) stands up a minimal `HttpApi` with one route
behind a Worker `fetch` export routing to a DO stub, and (2) passes the existing e2e suite plus an
`HttpApiTest` tier against it. If the Worker adapter works end-to-end under those tests, the refactor
earns its risk; if it fights the runtime, this ADR stays `proposed` and we keep the hand-rolled transport.

## Considered and rejected

- **Build it now, alongside the shared wire schema.** Rejected: bundling a speculative architecture bet
  into the same pass as two clean, documented wins muddies both and risks the wire-schema work on an
  unproven adapter.
- **Adopt `HttpApiClient` on the client only, keep the Worker hand-rolled.** Rejected as the worst of
  both: you take on the client rewrite and lose the single-source-of-truth payoff that only exists when
  *both* sides derive from the one `HttpApi`.

## Consequences

- **No code changes.** This ADR is a placeholder so the direction survives; the current transport stands.
- **When revisited, the shared wire schema (`src/data/wire-schema.ts`) is the natural seed** — its
  `Node`/`ChangeOp` schemas become endpoint payload schemas, so the work done for the frame-validation
  pass is not thrown away.
