# ADR 0021: Protected nodes (plugin-declared, core-enforced, delete-only)

Status: accepted (2026-06-23), implemented. Extends the plugin architecture
([ADR 0018](./0018-plugin-architecture.md)); first consumer is the Daily Notes plugin's
container ([ADR 0019](./0019-daily-notes-plugin.md)).

As built, the composed `isProtected(nodeId)` lives in `registry.ts`; the core consults it
in `OutlineEditor`'s `onDeleteNode` — the single funnel all three delete gestures
(Backspace-on-empty, `Mod+Shift+Backspace`, `Mod+Shift+Delete`) flow through — and returns
early (silent no-op) when it's true.

## Glossary

- **Protected node** — a node the core refuses to **delete**. Protection is delete-only: a
  protected node can still be renamed and take children. (Canonical term; "locked" is
  avoided because it implies read-only.)
- **Protected predicate** — the live `isProtected(id)` a plugin contributes, composed in
  the registry like every other seam; core mutations consult the composed predicate.

## Decision

A node can be **protected**, and the core refuses to delete it. **Which** nodes are
protected is **plugin-declared via a live predicate** (reading the plugin's own data),
composed in `registry.ts` into one `isProtected(id)` the core consults from `removeNode`
and the Backspace-merge path. The core knows "some ids are protected," never *why*.

- **Not a `Node` field.** Seam E keeps plugin meaning off the schema; no `collection.ts`
  migration.
- **Not a static list.** The protected id (the daily container) is created at runtime, so
  protection must read current plugin state — hence a predicate, not a constant.
- **Delete-only scope** for v1. Reparent / indent / outdent locks are deliberately out.

## Why

- **It protects content, not just structure.** `removeNode` cascades the entire subtree, so
  deleting the daily container would erase every day note and everything written under them.
  Regenerate-on-demand (the no-seam alternative) only restores *empty* nodes. Protection is
  the only thing that preserves what you wrote.
- **Predicate over `Node` field.** Keeps protection plugin-owned and the core generic —
  same shape as every other seam (core enforces a rule, the plugin supplies the meaning).
  No schema change, no migration.
- **Live predicate over a static list.** The protected node is created at runtime; a
  constant couldn't name it. The predicate reads the plugin's index at call time.
- **Delete-only is the narrowest rule that solves the problem.** Move/indent locks are
  speculative; add them behind the same predicate later if a real need shows up.

## Rejected alternatives

- **`locked: boolean` on `Node`.** Seam E violation, a migration, and core schema coupled to
  a plugin concept. Rejected.
- **A protected-ids side-collection the core imports.** Core depending on a *specific*
  plugin's data inverts the dependency direction. A predicate the registry composes keeps
  core → plugin pointing the right way (core calls a contributed function; it imports
  nothing plugin-specific). Rejected.
- **No protection (idempotent regenerate only).** Loses written content on an accidental
  container delete because of the cascade. Rejected — the whole point is durability.
- **Locking move / indent / outdent too.** Out of scope for v1; protection is delete-only
  until something needs more.

## Known rough edges

- **A refused delete is a silent no-op** (as built) — same as moving past the zoom root. If
  that's ever confusing, a toast or subtle shake is the candidate.
- **Protection is on the node itself, not its subtree.** A protected container can still be
  emptied child-by-child; only the container node resists deletion. That's intentional — you
  can clear old days, you just can't nuke the whole journal in one stroke.
- **Composition order is irrelevant** (protection is a logical OR across plugins), so unlike
  view transforms there's no "first non-null wins" subtlety.
