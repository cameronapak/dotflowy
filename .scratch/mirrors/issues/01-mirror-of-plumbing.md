# 01 — `mirrorOf` plumbing (ships dark)

Status: done (branch `feat/mirror-of-plumbing`, pending review/merge)

Implemented 2026-06-30. All acceptance gates green: typecheck + typecheck:worker +
typecheck:test + lint + unit (138 pass) clean; e2e matches `main` (the only failures
are the pre-existing daily-notes `goHome` URL-race, identical on baseline). Reverse
index built in `buildTreeIndex` (pure, unit-tested) and maintained incrementally in
`tree-store.ts`. Existing-DO migration is a column-existence-guarded `ALTER` in the DO
constructor; legacy D1 import maps to `mirrorOf: null`; client backfills null at
snapshot load. Nothing reads `mirrorOf` yet (dark, as designed).

Stage 0 of [PRD](../PRD.md) / [ADR 0022](../../../docs/adr/0022-node-mirrors.md). Adds the data field and
the reverse index with **no behavior change** — pure foundation.

## Scope

- `src/data/schema.ts`: add `mirrorOf: Schema.NullOr(Schema.String)` to `nodeSchema` (required + nullable,
  **no default** — [ADR 0003](../../../docs/adr/0003-no-schema-defaults.md)).
- `src/data/tree.ts`: `makeNode` sets `mirrorOf: null`.
- `worker/wire.ts`: add `mirrorOf` to the node body schema; confirm the Worker's derived `Node` type picks
  it up (no hand-written drift — [ADR 0014](../../../docs/adr/0014-validate-the-worker-do-trust-boundary.md)).
- DO `nodes` table (`worker/outline-do.ts`): add the `mirrorOf` column to the constructor schema; ALTER/
  default-null for existing DOs so reads don't break.
- `src/data/collection.ts`: backfill `mirrorOf: null` on snapshot load for rows missing it (the
  `healSiblingChains` pattern).
- `src/data/tree-store.ts`: maintain a reverse index `sourceId → instance ids` alongside `childrenByParent`,
  updated incrementally on the same change path (used by Stage 1 count badge + Stage 3 promote).

## Acceptance

- [ ] `mirrorOf` round-trips client → Worker → DO → echo, defaulting `null`.
- [ ] Existing outlines load unchanged (backfill works; no schema-typed-collection regression).
- [ ] Reverse index correct under insert/delete/move (unit test on `tree-store`).
- [ ] typecheck + typecheck:worker + typecheck:test + lint + unit green; existing e2e unchanged.

## Notes

Nothing renders or behaves differently after this issue — that's the point. Mergeable on its own.
