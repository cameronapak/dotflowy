# Dotflowy

Dotflowy is an outliner: nested bullets, per-user sync, and a plugin-extended editor. It is a React SPA with no SSR, on Cloudflare Workers. Each user's outline lives in its own Durable Object.

Keep this file brief. Put task-specific guidance behind a pointer.

## Gotchas

- **Local dev is `bun run cf:dev` on port 8787.** `bun run dev` on :3000 has a broken database on Cam's machine. Why, and the rest of setup: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Guardrails

- **Grill first.** New plugin, route, seam, `Node` field, side-collection, or ADR-worthy behavior: read the matching ADRs, then ask the user to run `/grill-with-docs` (user-invoked only). If they waive it, hold the design against those ADRs by hand. An agent can invoke `/domain-modeling`, `/code-review`, `/security-review`, and `/ft-create-concise-pr`.
- **There is no client-side data migration.**
- **Key the DO through `resolveUserId`**, never the email. The one exception is the owner-continuity bridge to `'default'`.
- **The `/api` session check trusts the server session.**
- **The SSRF guard in `worker/unfurl.ts` revalidates every redirect hop.**
- **Google is `disableSignUp: true`**, never `disableImplicitSignUp`. Signup gates fail closed: `SIGNUP_OPEN` must be the exact literal `"true"`. Admin routes return 404.
- **Send all transactional email through `worker/email.ts`.** Park sends on `ctx.waitUntil`.
- **Decode request bodies against Effect Schema.**
- **The app is a pure static SPA.** Code that touches `nodesCollection` stays off the server and render pass.
- **Lunora sync stays opt-in.** User-facing copy must not name Lunora. Turning it off returns the last classic snapshot.
- **Documentation Freshness.** If `AGENTS.md` or `README.md` becomes false about a path, command, or tool, correct it in the same change. Ask first before changing policy, philosophy, or positioning.
- **Run the app before calling an observable change done.** Drive it in `bun run cf:dev` or an e2e spec.

## Design

New feature or design: `ls docs/adr/` and read the ADRs that match the surface. Filenames name their surface except:

| Surface                                                | ADR                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Plugin seams, adding a plugin                          | 0001, 0031, and [`docs/plugins.md`](./docs/plugins.md) |
| Structural write atomicity, and why field edits differ | 0009, 0010                                             |
| Auth gate, Google sign-in, email verification          | 0011                                                   |
| Effect: errore removal, sync socket, schemas, fiber    | 0012, 0013, 0021, 0053                                 |
| Touch targets, reading size, and the bullet dot        | 0029                                                   |
| Lunora sync (experimental, flag-gated)                 | 0058                                                   |

## Architecture

Structure, data model, new `Node` field, tree reads: [`docs/architecture.md`](./docs/architecture.md). **`rootId` is route-owned.** Setup and local dev: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Editor

**A node renders in three places.** Caret, folding tokens, keymaps: [`docs/plugins.md`](./docs/plugins.md).

## Plugins

Plugin, seam, token, or kit UI: read [`docs/plugins.md`](./docs/plugins.md).

## Testing

Testing or coverage: read [`CONTRIBUTING.md`](./CONTRIBUTING.md). **A perf guard asserts a countable invariant.**

## Effect

**The typed-error channel in Effect is the error model.** Opensrc path and `kv-api.ts` throw: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Billing

Entitlements and checkout: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Lunora

Experimental sync, live reads, `isPersisted`, `expectedTable`: [ADR 0058](./docs/adr/0058-lunora-replaces-custom-outline-sync.md).

## Review

PR description: `/ft-create-concise-pr`. Review: `/code-review`. Auth, SSRF, Worker-to-DO trust, or signup gate: `/security-review`.

## Release

Version bump or changelog: [ADR 0046](./docs/adr/0046-changelog-and-release-versioning.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Landing

Landing site (`landing/`, dotflowy.com): Geist only, no mono. Accents match the app palette. Feature bullets stay vertical on desktop. Keep "Workflowy alternative" out of the H1 and the footer brand row. Icons in the app: free MIT Hugeicons (`@hugeicons/react`, `@hugeicons/core-free-icons`) at default stroke.

## Tooling

The three blocks below are written by their own tools. The `:start` and `:end`
markers are how each tool finds its block to replace. Never hand-edit inside
them, and never drop the markers: without them the next run appends a duplicate.
Neither fff nor codegraph reaches `~/.opensrc/`.

<!-- intent-skills:start -->

## Skill Loading

Before substantial work:

- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

<!-- codegraph:start -->

## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question                                      | Tool                |
| --------------------------------------------- | ------------------- |
| "Where is X defined?" / "Find symbol named X" | `codegraph_search`  |
| "What calls function Y?"                      | `codegraph_callers` |
| "What does Y call?"                           | `codegraph_callees` |
| "What would break if I changed Z?"            | `codegraph_impact`  |
| "Show me Y's signature / source / docstring"  | `codegraph_node`    |
| "Give me focused context for a task/area"     | `codegraph_context` |
| "Survey an unfamiliar module/topic"           | `codegraph_explore` |
| "What files exist under path/"                | `codegraph_files`   |
| "Is the index healthy?"                       | `codegraph_status`  |

### Rules of thumb

- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **`codegraph_explore` is the heavy hitter** for unfamiliar areas — it returns full source from all relevant files in one call, but is token-heavy. If your harness supports parallel subagents (e.g., Claude Code's Task tool), spawn one for explore-class questions to keep main session context clean.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: _"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"_
<!-- codegraph:end -->

<!-- fff:start -->

For any file search or grep in the current git-indexed directory, use fff tools.
<!-- fff:end -->
