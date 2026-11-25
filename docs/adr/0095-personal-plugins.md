---
status: accepted
---

# Personal plugins

A personal plugin adds views and commands to one user's Dotflowy. The user's
own agent writes it over MCP, and only that user sees it. Cam chose the
direction after the plugin-lab prototypes, their security review, and an
independent review of the lab code.

This first release is **declarative**: a plugin is a JSON definition, and
reviewed, compiled-in code renders it with Dotflowy's components. It stays
inside ADR 0031's Lane A. Arbitrary code (frames, backends, `::run`), secrets,
and MCP Apps are not in this release; each needs its own amendment and release
checks (see "Not in this release").

## Decisions

1. **Agents author; Dotflowy has no plugin chat.** MCP tools on `/mcp` read
   the guide, list, save, activate a version, remove, and delete history.
   Every save is a version. Removing keeps history; deleting history is a
   separate, confirmed tool.
2. **A definition is data, and unknown keys are an error.** It may contain
   components (`chip`, `progress`, `board`), `/` commands with an optional
   child template, a subheader band, and a side panel built from blocks
   (heading, text, list, chips, notepad). A definition that asks for anything
   else, such as HTML, a backend, or settings, fails validation instead of
   saving a silently different plugin.
3. **Comark places a component.** Inline `:name[label]{attrs}` needs its
   `[label]`, so prose like `10:30` or `Note:that` never matches. A block is a
   bullet starting with `::name{attrs}`, matched by exact name; its children
   are the slot. A bullet may end with `{tone="green"}` to color itself in a
   block view. Token patterns list only the account's installed names, so an
   unknown name never matches. Stored text is never rewritten: export,
   search, copy, and sync see it verbatim, and turning a plugin off leaves
   readable text. The shared grammar lives in `src/data/comark.ts`.
4. **One owner per component name.** A plugin's live version claims its
   component names. Another plugin cannot activate a version that uses a
   claimed name. Dotflowy reserves names it may use for built-ins, such as
   `verse`, so the Bible plugin can adopt the syntax later without a
   collision.
5. **Source lives in Cloudflare Artifacts, one repo per plugin.** The repo
   `<doName>.<pluginId>` holds `plugin.json`; every save is a commit, so
   history is never trimmed and the live version cannot be evicted. One repo
   per plugin lets a plugin be shared later as a fork that runs as the
   forker's own instance. The Worker writes with `isomorphic-git` over an
   in-memory filesystem, because the binding only creates, reads, lists
   history, forks, and deletes. A push is a compare-and-swap on the branch:
   of two saves from the same head, one lands and the other gets a retryable
   conflict. A save may pass `baseVersion` to refuse a save over someone
   else's.
6. **The user's Durable Object holds what is live.** Kv collection
   `personal-plugins` (not in `KV_COLLECTIONS`, so `/api/kv` can't reach it)
   stores the opt-in, each plugin's repo, user switch, live version and its
   definition, the name claims, and notepad text. Page loads read the DO,
   never Artifacts. Activation writes the pointer and the claims in one
   `compareAndSetKv`, so a race fails cleanly instead of half-applying.
7. **Gates, all server-side.** The routes 404 and MCP lists nothing unless
   `PERSONAL_PLUGINS` is exactly `"true"` and the `ARTIFACTS` binding exists.
   A paid plan is required, and an optional `PERSONAL_PLUGINS_USERS` list
   limits the beta. The account opts in with Cmd+K "Enable personal plugins
   (beta)" or the Settings switch; until then MCP lists only the read-only
   guide, and every other route refuses. Read-only API keys see only the
   read tools.
8. **Off means off in the browser too.** The client plugin's new `isActive`
   seam keeps the registry from composing its tokens, slots, subheader, and
   commands until the server reports an eligible, opted-in account. Only the
   opt-in command stays reachable, and only for an eligible account. A
   401/403/404 clears everything. The registry's `usePluginSeamVersion`
   re-decorates text and rebuilds hidden rows when the plugin's contributions
   change.
9. **Lifecycle.** Account deletion deletes the user's plugin repos before the
   DO wipe; a failure aborts the deletion. The existing DO backup, restore,
   and wipe already cover the kv rows. Off-site backups do not copy
   Artifacts repos: Artifacts is the durable history, and a restored DO still
   renders from its stored definitions if a repo is gone.

## Not in this release

The lab also tried these. They stay out until each has its own reviewed gate.
The lab branch keeps the code.

- **Sandboxed frames and `::run`.** Need the frame-navigation fix (a frame can
  navigate itself and keep its `contentWindow`), an amendment letting Lane B
  draw in node body slots, and a size and rate limit.
- **Backend code in Dynamic Workers.** Needs host-derived isolate keys, egress
  checks that normalize hosts (trailing dots, IPv4-mapped IPv6, private
  ranges), and quotas.
- **Secrets.** Need per-user, per-plugin grants bound to one https origin and
  header.
- **MCP Apps.** Need narrow, subtree-scoped tools; results are model-visible.
- **Explicit `:verse[…]` for the Bible plugin, and reveal motion.** Editor
  changes that ship on their own, without personal plugins.

## Considered and rejected

- **Revisions in the DO's kv.** The lab did this; one row could pass the 2 MB
  limit after a few large revisions, a 20-revision cap could drop the live
  one, and concurrent saves lost updates.
- **One Artifacts repo per user.** Forks copy whole repos, so sharing one
  plugin would copy the others and lose its own history.
- **Temporary storage now, Artifacts later.** A migration for no gain; the
  first release narrows what a plugin can do instead.

## Consequences

- Artifacts needs Workers Paid and is billed by operations and storage. The
  paid-plan gate covers it.
- The namespace `dotflowy-personal-plugins` uses the `us` jurisdiction. Create
  it before the flag goes on, in the dashboard (Storage & databases >
  Artifacts) or with `POST /accounts/:id/artifacts/namespaces` and
  `{"namespace":"dotflowy-personal-plugins","jurisdiction":"us"}`. The first
  repo otherwise creates it unrestricted, and a jurisdiction can't change
  later. Wrangler config can't set it.
- Production enables the beta in `wrangler.jsonc` `vars`, not the dashboard:
  a deploy replaces dashboard vars. Set `PERSONAL_PLUGINS` to `"true"` and
  `PERSONAL_PLUGINS_USERS` to the allowed Better Auth user ids.
- Artifacts is in beta. If it changes, the DO pointer and version contract
  stay; only `worker/personal-plugin-source.ts` moves.
- Agent edits reach an open tab by polling every 5 seconds while it is
  visible. Moving them onto the sync socket is a later change.
