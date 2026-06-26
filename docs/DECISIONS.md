# Dotflowy decisions

The handful of choices a coding agent would get **wrong by reading the code alone** — where
the source shows the *what* but not the *why*, and the obvious "fix" quietly breaks something.
Everything else lives in the code itself, in `AGENTS.md` (operational rules + the live
plugin-seam map), or in `README.md` (data model, layout, install).

The bar for an entry here: *would an agent, reading only the source, do the wrong thing?* If the
code already makes the call obvious, it does **not** belong here — the code is the doc. This file
is the exception, not a changelog. Full history, including superseded decisions and their rejected
alternatives, is in `git log` (this repo kept 28 numbered ADRs there before consolidating to this).

---

## Plugin architecture

The editor is a small core extended by **plugins compiled into the bundle** — an internal
registry in `src/plugins/`, *not* runtime-loaded. `code`, `links`, `tags`, `todos`, `daily`, and
`route-bible` are themselves plugins, so the core carries no feature-specific branches. A plugin
registers into a fixed, finite set of **seams** (inline tokens, delegated clicks, `/` commands,
keymap, row/header slots, view transforms, caret menus, paste/autoformat, side-collections, search
providers). The live seam map and current owners are the Plugins section of `AGENTS.md`; this is
the design rationale.

**Two-tier data ownership is the load-bearing rule.** The decider: *does any core view-transform
(show/hide, fade, sort, breadcrumb) need this field?* Yes → it's a core primitive on `Node`. No →
it's a **side-collection keyed by node id**, never a `Node` field (clean uninstall, no migration,
rides the sync path).

**Don't:**
- Add plugin-owned fields to the `Node` schema (migrations, the no-zod-defaults problem, sync
  churn, orphan fields on uninstall). Plugin data is a side-collection — this is also why
  "protected node" is a *composed predicate*, not a `protected:` column.
- Give each token its own regex/scan — N plugins must not mean N passes. The core composes one
  alternation, one `matchAll`, and owns escaping (tokens return structured `El`/`WidgetEl`, never
  raw HTML).
- Run arbitrary per-keystroke plugin code in the decorator, or reach for runtime/after-install
  plugin loading (deferred — a module loader + sandbox + capability model this project doesn't
  need).

**The one named exception:** `completed`/`isTask` stay `Node` fields even though completion is the
todo plugin's concept — because hide-completed and fade-inheritance read them every render, and a
side-collection join on the hottest path isn't worth it. Core declares the column; exactly one
plugin reads it. Don't generalize this into "plugins can add fields."

---

## Subheader vs header slot

**Header slots** are persistent actions in the header's right cluster (the daily "Today" button).
**Subheader slots** are contextual state below the header — the tag filter bar, a future week nav,
a pomodoro timer. The core renders every non-null subheader slot into one **muted band**
(`bg-muted/30`) that **collapses with animation** when all slots return null and **sticks with the
header** as one unit. Header = "do something"; subheader = "here's what's shaping the view."

**Don't** put contextual/filter UI in header slots (wrong semantics, competes with global actions)
or leave it inline above the outline content (it's chrome, not document). Multi-slot layout within
the band (leading/main/trailing regions) is deferred until a second consumer ships — v1 renders all
non-null slots in one flex row.

---

## No zod defaults in the schema

`src/data/schema.ts` declares **no `.default()` values**. Build every node through `makeNode()` in
`tree.ts`.

**Why it's not in the code:** the schema looks incomplete without defaults, so the obvious tidy-up
is to add them. But a zod `.default()` makes that field optional in zod's *inferred input type*,
and TanStack DB's schema-typed collection overload reads that type — optional fields there collide
with the collection's expectation of fully-formed `Node`s, producing type errors (or silently
looser types) at the collection boundary.

**Don't** add `.default()` for ergonomics. The typed-collection guarantee is worth more.

---

## Localized rendering via the tree store

`OutlineNode` takes a `nodeId` and reads **its own slice** from the tree store (`useNode`,
`useVisibleChildIds` in `tree-store.ts`) — it never receives `node` or `index` as props. A
keystroke then re-renders only the edited bullet (measured: ~300 commits/keystroke → ~1) instead
of the whole visible tree.

**Why it's not in the code:** `React.memo` on `OutlineNode` looks like it should already prevent
this. It was inert — `useTree` rebuilt a fresh `index` object every edit and passed it as a prop,
busting the shallow compare. The fix isn't "memoize harder"; the node must be read *reactively per
component*, because completion/collapse/task toggles change a node's own object without changing
structure, so a parent threading the node down as a prop wouldn't re-render to pass the new one.
Why per-node `memo` works at all: Immer keeps the object reference of every *unchanged* row stable
across an edit, so each `useNode` snapshot is referentially stable for all but the edited node.

**Don't:**
- Pass `node`/`index` as props to `OutlineNode` (reintroduces the storm).
- Pass a fresh `commands`/callback object per render — the memo only pays off while those stay
  referentially stable.
- "Fix" it with a custom memo comparator that ignores `index` — a parent can't tell a deep
  descendant changed without recursing, so it freezes the subtree below it.

---

## Rich links: the source-offset caret

Markdown `[label](url)` is parsed from `node.text` (no schema field) and is the one construct that
**folds** — it renders as a clean `<a contenteditable="false" data-src="[label](url)">` unless the
caret is within/adjacent to it. Reveal is **per-link**: at most one unfolds at a time.

**Why it's not in the code, and the landmine:** because a *focused* bullet can hold *folded* links,
`el.textContent` is **no longer the source** — the folded `<a>` shows `label`, but its source is
the full markdown. So:
- **`readSource(el)`** (`inline-code.ts`) reconstructs the markdown (`data-src` for folded atoms,
  `textContent` otherwise). It must replace `el.textContent` in `onInput`, paste, **and the
  slash/tag menus** — a `/cmd` or `#tag` on a folded-link line would otherwise flatten the url
  (silent data loss).
- **`getCaretOffset`/`setCaretOffset` speak SOURCE offsets**, adding `(data-src-len − label.length)`
  per folded link before the caret.

All of it fast-paths out on lines with no `](`, which is 99% of them.

**Don't:** assume `textContent` is the source anywhere a line can hold a link; revert to per-bullet
reveal (noisy on multi-link lines); or thread a full source↔display offset map — per-link reveal
keeps the active link 1:1, which is strictly less mapping.

---

## React token widgets

A Seam-A token can render a **real React component** (return a `WidgetEl` + declare `component`)
instead of a serialized `El` string. The core serializes it to one
`<dotflowy-widget data-src=… contenteditable="false">` atom in the same string hot path, and the
custom element mounts a React root when the browser upgrades it. Consumer: route-bible's chip.

**Why it's not in the code:** the contentEditable's innerHTML is rebuilt imperatively on every
keystroke (see the tree-store decision), which would destroy any normal React mount. A **custom
element is the bridge** — it gets re-parsed and re-upgraded on each rebuild, so the *browser* owns
its lifecycle, not React. The core keeps emitting a string.

**Don't:**
- Use a React portal target (gets destroyed by `el.innerHTML = …` → silently never renders).
- Use shadow DOM (a shadow boundary on an inline node inside contentEditable breaks selection).
- Pass live callbacks as props — they cross the boundary as JSON (`data-props`); route interaction
  through Seam B instead.

`El` stays the fast path for plain tokens (code, links, tags); only a token declaring a `component`
pays the React-root cost.

---

## Custom tag colors

A `#tag`'s color is **chosen and stored** (not derived from the name), defaulting to a neutral
outline. It lives in a side-collection synced over `/api/kv` (see *Sync via a per-user Durable Object*) and is
painted by **one generated stylesheet keyed on `data-tag`** (`TagColorStyles`, mounted once in
`__root.tsx`).

**Why it's not in the code:** the stylesheet indirection looks like overkill until you see the
alternative. A color class per chip would force every bullet containing the tag to **re-decorate**
on a color change — O(instances) React work, and there's no cheap "re-decorate all" signal in the
per-node store. Keying off `data-tag` in one stylesheet makes a recolor an **O(1) DOM write** the
browser applies to all instances for free, with zero React re-renders.

**Don't:** derive colors by hashing the name (noise masquerading as meaning; pre-spends the
palette); put color on `Node` or per-occurrence (it's global to the tag *name*); or use
per-instance classes. The generator skips unsafe tag names (`[\p{L}\p{N}_-]+` guard) — keep that,
it's the CSS-injection guard.

---

## Sync via a per-user Durable Object

One Cloudflare **Worker** (`worker/index.ts`) serves the static SPA *and* the sync API — `/api/nodes`
(the outline) and `/api/kv` (plugin side-collections: tag colors, daily index). Each `/api` request
is routed to the caller's **Durable Object** (`UserOutlineDO`, `worker/outline-do.ts`), whose
colocated **SQLite** holds that user's entire outline plus the side-collections. Inside a per-user
DO the `owner` column is gone — the DO *is* the scope — and its single thread serializes a user's
edits across devices, so there is no last-write-wins reconciliation. `collection.ts` is still a
TanStack DB `queryCollectionOptions` collection over the unchanged `/api/*` contract, so the tree
store, mutations, and components never changed. Sync is *near-real-time on tab focus*
(`refetchOnWindowFocus`), not live push.

**The DO routing key must never be an email.** A DO name is *permanent* (no rename), so keying it
off a mutable value would orphan a user's whole outline on an email or auth-provider change.
`resolveUserId()` returns a **constant** today — the app is single-user behind the auth gate — and
becomes the stable `session.user.id` when real accounts land. Do NOT "fix" it to route off
`authorize()`'s `owner`/email; that reintroduces exactly the orphaning this avoids.

**D1 is kept, but demoted — it is no longer the outline store.** It serves two roles: (1) the
**source for the one-time, non-destructive import** of a user's pre-DO rows into their DO
(`ensureSeeded` reads D1; the DO marks itself `seeded` and never re-imports), and (2) the reserved
home for a future identity store. The `migrations/` SQL files (and `db:migrate:*`) still apply to
that D1; the DO's own schema is created in its constructor, so it has **no SQL migration file** —
its wrangler migration is the `new_sqlite_classes` tag.

**Why a DO over D1-direct, or ElectricSQL/Postgres?** The browser can reach neither D1 nor a DO
directly — both are Worker bindings, so any of them needs the server tier. A per-user DO *also*
gives colocated storage (sub-ms reads next to compute), a single-writer thread that removes
conflict reconciliation, and the natural home for future per-user real-time (WebSocket Hibernation)
and subtree sharing. Electric gives real-time out of the box but isn't Cloudflare-native (must be
hosted elsewhere) — off-goal for an all-Cloudflare deploy.

**The SPA / no-SSR constraint lives here too:** the React app is a pure static SPA — never run code
that touches `nodesCollection` during a server/render pass (the tree store skips its subscription
on the server; hooks supply `getServerSnapshot` so `/` prerenders cleanly).

**Don't:** key the DO off an email/owner (permanent-name orphaning); reach for ElectricSQL or a
separate Postgres backend (off the all-Cloudflare goal); try to query D1 or a DO from the client
(impossible — both are Worker bindings); have the `/api/nodes` GET return a *partial* node set (the
collection deletes the rest); or extract a generic `createKvCollection<T>` factory for
side-collections — each must pass its **concrete** zod schema inline, or schema inference falls
through to `Record<string, unknown>`.

---

## The auth gate

The Worker authenticates the single user via a three-tier `authorize()`, in order: (1) **Cloudflare
Access** email header (preferred); (2) **localhost** → `local-dev` owner (dev only); (3) **HTTP
Basic Auth** against the `APP_PASSWORD` secret, **fail-closed if unset**. The Worker gates **every
path** (`run_worker_first: true`), not just `/api/*`.

**Why it's not in the code:** gating every path looks unnecessary — why challenge static-asset
requests? Because **a `fetch()` that gets a 401 does not trigger the browser's Basic Auth prompt —
only a document navigation does.** So the Worker must challenge the `/` document load; the browser
then caches the credentials and sends them on every asset and `/api` fetch automatically. Gate only
`/api` and the prompt never appears.

**Don't:** gate only `/api/*` (auth silently never prompts); remove the Basic Auth tier (the app is
unusable until Access is configured, which needs a custom domain + dashboard); or relax any tier to
trust a client-supplied owner. Access stays tier-1 and supersedes the Basic Auth gate with no code
change once it's set up.
