# 04 — Promote on delete (source/instance distinction goes invisible)

Status: ready-for-human

Stage 3 of [PRD](../PRD.md) / [ADR 0022](../../../docs/adr/0022-node-mirrors.md). Makes "delete the source"
safe: content survives in a remaining instance instead of orphaning. Behind the flag.

## Scope

- **Delete a mirror** = remove the one instance node (its "children" are the source's — untouched). Trivial;
  confirm it's already correct from Stage 1's create path.
- **Delete the source with surviving instances = promote** (one `runStructural` batch,
  [ADR 0009](../../../docs/adr/0009-atomic-structural-writes.md)):
  1. pick the oldest surviving instance `M'`;
  2. clear `M'.mirrorOf`;
  3. reparent the real children under `M'` (set `parentId`, fix the sibling chain);
  4. repoint every other mirror's `mirrorOf` at `M'`;
  5. delete the old source.
- **Cascade-aware:** when a node is removed as part of an ancestor-subtree delete, promote to a surviving
  instance that is **outside** the deleted subtree. Content dies only when the **last** instance is gone.
  Drive the lookup off the reverse index (Stage 0).
- **Undo/redo:** promote replays as one atomic snapshot diff (insert/update/delete mix), same as any
  structural batch.

## Acceptance

- [ ] Delete a source that has a Today mirror → content promotes into Today; project row gone; children
      intact under the new source; other mirrors repointed.
- [ ] Delete a whole **project** containing a source whose mirror lives in Today (outside the project) →
      content promotes into Today, not lost.
- [ ] Delete the **last** instance → content actually gone (no zombie rows, reverse index cleaned).
- [ ] Undo a promote restores the prior source + all mirror pointers exactly.
- [ ] New e2e `mirror-promote.spec.ts` green serial; flag off → unchanged.

## Notes

Rare path in practice (you check tasks off; you delete the Today *mirror* when rescheduling — the trivial
case). But getting it wrong loses data, so the cascade-aware promote is the load-bearing test.
