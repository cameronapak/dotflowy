# Effect source via opensrc, not a vendored subtree

The Effect v4 reference source used to be a committed `git subtree` at `repos/effect-smol/` — 154 MB / ~2,000 files that skewed every search surface (fff, `git grep`, GitHub code search) with vendored hits. It's replaced by on-demand fetches via [opensrc](https://github.com/vercel-labs/opensrc): `bunx opensrc path Effect-TS/effect-smol` fetches the repo once into a machine-global cache (`~/.opensrc/repos/github.com/Effect-TS/effect-smol/<ref>/`) and prints the path, so agents `rg`/read against it with nothing in the working tree. opensrc is a pinned devDependency; `bun run effect:src` is the discoverable alias; `bun run setup` pre-warms the cache (failure-tolerant) so the source is available offline on every bootstrapped machine.

**The GitHub repo, not the npm package.** opensrc can also fetch the published `effect` package lockfile-resolved to the exact installed version, but the agent-guidance stack (`AGENTS.md`, `LLMS.md`, `.patterns/effect.md`, `packages/effect/test/`) exists only in the repo. Tip-of-main at fetch time is accepted drift — the subtree was already "whenever `repos:update-effect` last ran," never lockstep with the installed beta.

**Rejected:**

- _Keep the subtree_ — the search skew was the whole problem; a gitignored in-repo clone would still skew local tools.
- _History rewrite to reclaim the 154 MB_ — removal fixes every search surface on its own (search tools index the live tree); rewriting SHAs would break the commit links across the issue tracker. Clone size keeps the old blobs; `git clone --filter=blob:none` is the non-destructive mitigation if it ever hurts. Deliberate: the history shows the journey.
- _A dedicated codegraph index over the fetched source_ — the old per-machine index at `repos/effect-smol/.codegraph/` was never used; `rg` over the cache path covers the real access pattern (find an API, read a pattern file).

Do not re-vendor Effect source into the repo "so it's available offline" — the setup warm step already covers that.
