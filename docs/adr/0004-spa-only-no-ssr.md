# ADR 0004: SPA only, no SSR

Status: accepted (2026-06-21)

## Decision

The app runs as a client-only SPA. `vite.config.ts` sets `spa: { enabled: true }` and
there is no server-render pass.

## Why

The TanStack DB collection (`nodesCollection`) reads `globalThis.localStorage` as its
backing store. localStorage does not exist on the server, so any code that touches the
collection during render would crash or read empty data under SSR. Disabling SSR removes
that whole class of hydration/availability bug instead of guarding every access.

## Constraint for agents

Never run code that touches `nodesCollection` during a server or render pass. If a backend
swap later reintroduces SSR (see the README's backend-swap path), this decision must be
revisited — the collection's storage assumption is what's load-bearing here, not SPA mode
for its own sake.
