<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/public/logo-dark.svg" />
    <img src="/public/logo-light.svg" alt="Dotflowy" width="316" height="64" />
  </picture>
</p>

<p align="center">
  <strong>Room to think — get everything out of your head, shape it when you're ready, and find it when it matters.</strong><br/>
	<span>An open-source Workflowy alternative, extensible with plugins like Obsidian. Agent-native via MCP.</span>
</p>

<p align="center">
  <a href="https://dotflowy.com"><strong>dotflowy.com</strong></a>
</p>

---

Dotflowy is an outliner: one big tree of bullets you can zoom, filter, and
rearrange without friction. It's local-first at heart — a static SPA built with
[TanStack Start](https://tanstack.com/start) and
[TanStack DB](https://tanstack.com/db) — with a Cloudflare backend that syncs
your outline live across devices via a per-user
[Durable Object](https://developers.cloudflare.com/durable-objects/), behind
[Better Auth](https://www.better-auth.com) accounts.

## Highlights

- **Everything is a bullet** — nest, collapse, zoom into any node as a
  temporary root, drag the dot to reorder and reparent in one drop
- **Three node kinds** — bullet, task (checkbox + a "show completed" toggle),
  and paragraph (reads as prose)
- **Markdown-style rich text** — `inline code`, bold / italic / strikethrough /
  underline, highlights, links that fold to a clean label, and `||spoilers||`
  hidden from humans until the caret enters and redacted from AI agents
- **Organize as you type** — `#tags` filter in place (right-click to color),
  `[[node links]]` with backlinks, mirrors that window one node into many
  places, daily notes with a Today button and `[[YYYY-MM-DD]]` date chips
- **Keyboard-first** — a `/` command palette, a `Cmd/Ctrl+K` command center,
  whole-node selection, quick-add capture, undo / redo
  ([all shortcuts](./docs/keyboard.md))
- **In and out freely** — multi-line paste lands as real nodes, copy gives
  markdown back, OPML import / export speaks the Workflowy dialect
- **Agent-native** — an OAuth-gated [MCP server](./docs/mcp.md) lets AI agents
  read and edit the outline, with edits syncing live into open editors

Not built yet: sharing.

## Run it locally

```sh
bun install
bun run setup      # once: secrets + local database schema
bun run dev        # vite (:3000) + worker (:8787) in one command
bun run seed:user  # optional: a ready-made dev account to sign in with
```

Open http://localhost:3000 and sign in as `dev@dotflowy.local` /
`dotflowy-dev`. Everything runs offline — no Cloudflare account needed until
you deploy. [`CONTRIBUTING.md`](./CONTRIBUTING.md) has the full setup guide.

## Documentation

| Doc                                      | What's in it                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Architecture](./docs/architecture.md)   | The data model, persistence + sync design, the plugin system, the stack, and the project layout            |
| [Deploying](./docs/deploying.md)         | Self-hosting on Cloudflare Workers, auth + signup configuration                                            |
| [Agents (MCP)](./docs/mcp.md)            | Connecting AI agents to your outline over the Model Context Protocol                                       |
| [Keyboard shortcuts](./docs/keyboard.md) | The full key reference                                                                                     |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)   | Setup, the dev loops, the pre-PR check matrix, repo conventions                                            |
| [`AGENTS.md`](./AGENTS.md)               | Per-feature rules and gotchas — written for coding agents, canonical for _why_ the code is shaped this way |
| [`docs/adr/`](./docs/adr/)               | One decision record per load-bearing choice                                                                |
| [`CHANGELOG.md`](./CHANGELOG.md)         | What's new, release by release                                                                             |

## License

Copyright © FAITH TOOLS SOFTWARE SOLUTIONS, LLC. Released under the
[O'Saasy License](./LICENSE). Source is available for learning, modification,
and self-hosting; offering a competing hosted SaaS product is reserved to the
copyright holder.
