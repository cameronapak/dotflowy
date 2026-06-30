# No schema defaults

`src/data/schema.ts` declares **no defaulted or optional fields**. Build every node through
`makeNode()` in `tree.ts`.

**Why it's not in the code:** the schema looks incomplete without defaults, so the obvious tidy-up
is to add them. But a default makes that field optional in the schema's *encoded (input)* type,
diverging from the fully-required `Node` the collection decodes to — and TanStack DB's schema-typed
collection overload trips over that optionality at the insert/update boundary, producing type errors
(or silently looser types) where it expects fully-formed `Node`s.

**Don't** add a default for ergonomics. The typed-collection guarantee is worth more.

The constraint predates and outlives the schema library: `src/data/schema.ts` is **Effect `Schema`**
since zod was removed (Effect Schema is now the one schema language across client and Worker — see
[ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)), but the trap is identical. zod's
`.default()` made the *inferred input* optional; Effect's `Schema.optionalWith(…, { default })`
does the same to the *Encoded* type. Same divergence, same rule: no defaults.
