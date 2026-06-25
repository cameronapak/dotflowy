# `legacy/` — pre-Wasp outline editor (staging)

This is the **TanStack Start + Cloudflare** outline editor, moved here out of
`src/` during **Phase 1** of the Wasp migration (see
[`docs/PRD-wasp-migration.md`](../docs/PRD-wasp-migration.md)).

## Why it's here

Wasp's `wasp start` runs `tsc` over the **entire** `src/` tree when it builds
its SDK. This editor code still imports TanStack Start/Router (`@tanstack/react-router`,
`@tanstack/react-start`) and other deps that are no longer installed, so leaving
it under `src/` breaks the Wasp build. Relocating it here keeps `src/` to just
the live Wasp app (`src/app`) while preserving every file (moved with `git mv`,
history intact) for the **Phase 3** client port.

Nothing in `legacy/` is compiled or bundled by Wasp.

## What happens to it

**Phase 3 (client port)** moves these back into `src/` as they're ported:

- Routing (`routes/`, `router.tsx`, `routeTree.gen.ts`) → React Router pages.
- The `@/...` import alias and TanStack-Router calls get rewritten.
- `tree-store.ts`, `mutations.ts`, the plugin registry, `OutlineEditor`/
  `OutlineNode`, and `styles.css` are preserved in behaviour (PRD §Client
  Migration Notes); only the routing + sync boundary change.

Once everything is ported, this directory goes away.
