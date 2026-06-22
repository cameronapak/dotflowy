# ADR 0005: No zod `.default()` values in the node schema

Status: accepted (2026-06-21)

## Decision

`src/data/schema.ts` intentionally declares no zod `.default()` values. Complete nodes are
always constructed through `makeNode()` in `tree.ts`.

## Why

A zod `.default()` makes that field **optional in zod's inferred input type**. TanStack DB's
schema-typed collection overload reads that inferred input type, so optional fields there
collide with the collection's expectation of fully-formed `Node` values. The result is type
errors (or silently looser types) at the collection boundary.

Considered and rejected: adding `.default()` for ergonomics and letting zod fill gaps. It
breaks the typed-collection overload, which is the more valuable guarantee.

## Constraint for agents

Don't add `.default()` to the schema. Build every node via `makeNode()` so all fields are
present at construction time.
