# XState v6 (alpha) + Effect Schema on the dotflowy frontend

Status: exploration / proof-of-concept
Owner: (you)
Branch: `claude/xstate-effect-schema-dotflowy-wvk879`

## Why this doc exists

Sandro Maglione shipped a full migration to **XState v6 alpha** and called out that its
headline feature — `schemas:` replacing v5's `types: {} as {...}` — accepts any **Standard
Schema** (Zod, Valibot, **Effect**). dotflowy already standardised on **Effect** (ADR 0012)
and authors its trust-boundary contracts as **Effect Schema** (`worker/wire.ts`, ADR 0014).
So XState v6 + Effect Schema is a natural fit: one schema library types the data model AND
the state machines.

This doc records the research, the exact versions/gotchas, and a **bounded PoC** (node
multi-selection) so the decision can be judged against real code before it's adopted.

## Research findings (verified against installed packages, not docs)

| Fact | Value | Source |
| ---- | ----- | ------ |
| XState v6 line | alpha — currently `xstate@6.0.0-alpha.11` | npm `alpha` tag |
| React adapter | **`@xstate/react@7.0.0-alpha.1`** (npm `alpha` tag). NOT `@xstate/react@6` (that still targets xstate v5). Peer deps: `react ^16.8…^19`, `xstate ^6.0.0-alpha.1` | the package's own `package.json` |
| Effect → Standard Schema | **`Schema.toStandardSchemaV1(schema, options?)`** | installed `effect@4.0.0-beta.92`, `dist/Schema.d.ts:917` |
| **Gotcha** | The published Effect **v3** docs say `Schema.standardSchemaV1`. Effect **v4** (the beta we ship) renamed it to **`toStandardSchemaV1`**. Use the v4 name. | vendored `repos/effect-smol/.../Schema.ts:1107` + installed dist |
| Our stack | `effect@4.0.0-beta.92`, `zod@4`, `react@19`, `vite@8` | `package.json` |

### How the bridge works
- `Schema.toStandardSchemaV1(s)` returns `StandardSchemaV1<Encoded, Type> & S` — i.e. it bolts a
  `~standard` property onto the Effect schema, so the value is **both** an Effect schema and a
  Standard-Schema-v1 object. XState accepts it anywhere a `schemas` field wants one.
- XState infers from the **type-level** `~standard.types` phantom (Standard Schema's
  `InferOutput` = `NonNullable<s['~standard']['types']>['output']`). Effect's return type
  carries that phantom even though the runtime object only sets `{ version, vendor, validate }`,
  so **type inference flows without any runtime `types` value**.

### Two honest limits (set expectations)
1. **Mostly compile-time today.** XState's own changelog: `schemas` does runtime validation only
   "where supported", and for logic creators "schemas are type-only for now (opt-in runtime
   validation later)". So Effect Schema's role with v6-alpha is to be the **single source of
   truth for context/event/input/output _types_**. It does **not** replace `worker/wire.ts`'s
   real boundary validation.
2. **Prefer transform-free `Schema.Struct`s** for context/events so `Encoded === Type` and XState
   infers exactly what you expect. Transforms (e.g. `Schema.Date`) make XState see the decoded
   `Type` side — fine, just know which side you get.

## The other big v6 win for us: `createAsyncLogic` ↔ Effect

Our async work is *already* Effect (`kv-client-effect.ts`, the unfurl fetch). `createAsyncLogic`
gives `schemas.input/output`, a `timeout`, and an `AbortSignal`, and Effect interruption maps
onto that signal via `appRuntime` (`src/data/runtime.ts`):

```ts
const unfurlLogic = createAsyncLogic({
  schemas: {
    input:  Schema.toStandardSchemaV1(Schema.Struct({ url: Schema.String })),
    output: Schema.toStandardSchemaV1(Schema.Struct({ title: Schema.NullOr(Schema.String) })),
  },
  timeout: "8s",                                   // aborts the signal -> Effect interrupts
  run: ({ input, signal }) => appRuntime.runPromise(unfurlEffect(input.url), { signal }),
})
```

(Out of scope for this PoC, captured for the next phase.)

## Where it fits in dotflowy (and where it does NOT)

Good fits — discrete, imperative UI flows:
- **Node multi-selection** (`selection-state.ts` + `selection-mode.tsx`) — clearest state chart,
  off the keystroke hot path. **← the PoC.**
- Slash menu (`slash-menu.tsx`): `closed → open → filtering → picking`.
- Link-unfurl lifecycle (links plugin): the `createAsyncLogic` showcase.
- Drag-reorder (`use-drag-reorder.ts`): robust listener cleanup via entry/exit — but it's a hot
  imperative path (ADR 0010); do last, if at all.

Poor fits — leave alone:
- `tree-store` / `collection` sync (reactive dataflow, not a discrete machine).
- `view-state` (two continuous values, no transitions).
- sync reconnect (`realtime.ts`) / KV retry (`kv-client-effect.ts`) — Effect scoped resources +
  `Schedule` already do this better than a machine would.

## PoC scope (this branch)

Build a **parallel** XState v6 implementation of the selection *model*, behind a flag, leaving
the live singleton as the shipping path:

- `src/data/selection-machine.ts` — `setup({ schemas })` machine; **context + events typed with
  Effect Schema via `toStandardSchemaV1`**. States `idle / single / multi`. Transitions are v6
  inline `(args) => ({ target, context })` functions. The tree-dependent bit (which siblings are
  visible) is passed **into** events as a `siblings: string[]` snapshot, so the machine stays
  **pure and unit-testable** — the editor adapter is what reads the live tree.
- `src/data/selection-machine.test.ts` — `bun test` driving `createActor`, asserting state +
  context (proves the machine and the Effect-Schema typing work at runtime). Fits the repo's
  "pure logic only" unit tier.
- `src/data/use-selection-machine.ts` — a thin `@xstate/react` (`useMachine`) hook, to validate
  the React-19 adapter typechecks. **Unconsumed** — wiring into the editor is the next step.
- `src/data/flags.ts` — `isSelectionMachine()` toggle (`dotflowy:flag:selection-machine`),
  compiled default **off**.

Deliberately **not** in the PoC: replacing the live `selection-state.ts` wiring, the boundary
depth-walk (parent/child at a sibling edge — stays in the adapter), and any DOM/menu work.

## Swap-in plan (after the PoC is judged)

1. Behind `isSelectionMachine()`, have `selection-mode.tsx` drive the machine instead of calling
   the singleton mutators; the editor still computes `siblings` from the live tree and sends them.
2. Replace `useSelectionEdge(id)` reads with a `useSelector(actor, …)` per-row selector (same
   `useSyncExternalStore` primitive — preserves the ADR 0014 per-node-render budget).
3. Port the boundary depth-walk into a machine event (`EXTEND` carrying parent/child candidates).
4. Once parity holds in `e2e/node-multi-select.spec.ts`, delete the singleton + the flag together.

## Risks

- **Alpha-on-beta.** `xstate@6` + `@xstate/react@7` are both alpha; `effect@4` is beta. Pin exact
  versions; expect churn between alpha numbers (alpha.1→.11 already changed `enq` and target
  shorthand). Fine for a flagged dogfood; not yet load-bearing.
- **ADR-gated.** Introducing a new state primitive is hard-to-reverse and surprising-without-
  context → it should go through `/grill-with-docs` and earn a numbered ADR. See the draft ADR
  in this folder.
- **React Compiler.** Keep machines off the contentEditable hot path; `useMachine`/`useSelector`
  are `useSyncExternalStore`-based and compose with our stores, but `OutlineEditor` carries
  `"use no memo"` for a reason (ADR 0019).
- **Bundle.** `xstate` + `@xstate/react` ≈ ~20 KB min for one machine — a clarity/testability
  investment, not a correctness fix.

## Status / next

- [x] Deps installed (`xstate@6.0.0-alpha.11`, `@xstate/react@7.0.0-alpha.1`).
- [x] PoC machine + Effect-Schema bridge + flag + unit test (this branch).
- [ ] Judge the PoC; decide adopt / hold.
- [ ] If adopt: `/grill-with-docs` → numbered ADR → swap-in plan above.
