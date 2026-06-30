# 03 — Full editing parity inside mirrors (the hard part)

Status: ready-for-human

Stage 2 of [PRD](../PRD.md) / [ADR 0022](../../../docs/adr/0022-node-mirrors.md). The A1 gold-plate and the
**most regression-prone work in the app** — path-based identity for the caret-sensitive subsystems inside
mirrored subtrees. Gate on heavy e2e. Behind the flag.

## Scope

- **Path-based focus/caret:** `refs`, `pendingFocus`, `pendingFocusAtStart`, `pendingFlash`, and the
  `FocusPass` reverse-lookup must key off the **render path** for rows inside a mirror, not the bare node id
  (a node visible at two paths has two spans). `findFocusedId` resolves path → content id.
- **Caret nav** (`findVisibleNeighbor` / `buildVisibleRows` seq) operates on row addresses, so Arrow/Up-Down
  cross instance boundaries correctly.
- **Structural mutations redirect at the mirror boundary:** inserting a child *directly under a mirror* (or
  Enter-splitting / indent-outdent at the mirror's edge) must target the **source**, so the new node appears
  in every instance. Inside the subtree (real nodes) it already targets the real node — confirm.
- **Drag-reorder** (`use-drag-reorder.ts` / `virtual-nav.ts`): hit-test + projection by render path; dropping
  inside a mirror reorders the **real** nodes (and thus every instance). Document the surprise.
- **Multi-select** (`selection-state` / `selection-mode.tsx`): selection edges + `runMany` keyed by path; a
  run inside a mirror operates on the real nodes.

## Acceptance

- [ ] Type, Enter-split, indent/outdent, Backspace-merge inside a mirror — caret lands correctly, and the
      same edit appears in every instance.
- [ ] Add a child directly under a mirror → it shows under the source and all other instances.
- [ ] Drag a sub-item inside a mirror → reorders under the source (verified in another instance).
- [ ] Multi-select + move/indent inside a mirror behaves as on real nodes; no cross-instance focus bleed.
- [ ] The **same node visible at two paths simultaneously** (both homes on screen, e.g. top-level unzoomed):
      focusing one doesn't steal/echo into the other; both spans independent.
- [ ] Flag off → unchanged. New e2e spec `mirror-editing.spec.ts` green serial.

## Risk notes

This is where caret bugs hide. Budget for it. Consider landing Stage 1 to dogfood (text + completed sync +
view) and only starting this once the reference-grade behavior is proven in real use.
