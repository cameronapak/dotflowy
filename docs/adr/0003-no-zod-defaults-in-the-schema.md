# No zod defaults in the schema

`src/data/schema.ts` declares **no `.default()` values**. Build every node through `makeNode()` in
`tree.ts`.

**Why it's not in the code:** the schema looks incomplete without defaults, so the obvious tidy-up
is to add them. But a zod `.default()` makes that field optional in zod's *inferred input type*,
and TanStack DB's schema-typed collection overload reads that type — optional fields there collide
with the collection's expectation of fully-formed `Node`s, producing type errors (or silently
looser types) at the collection boundary.

**Don't** add `.default()` for ergonomics. The typed-collection guarantee is worth more.
