---
"dotflowy": patch
---

Testing now runs where it ships: unit tests run on Vitest with worker tests executing inside real workerd, e2e boots its own `wrangler dev` serving the built SPA, and `bun run verify` is the one-command gate CI runs. See ADR 0061.
