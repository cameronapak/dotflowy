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

**Two read paths for the live tree and view state.** The `commands`/drag/zoom closures must keep a
stable identity (a prop on every memoized node), so they can't close over this render's
`index`/`rootId`/`isHidden`. **Render reads** use the React values directly (the `index` from
`useTree`, the `rootId` prop, the `isHidden` memo) so the view stays reactive. **Event-time reads**
(pointer/key/click — after commit) go through module getters: `getTreeIndex()` (`tree-store.ts`) for
the tree, `getViewRootId()`/`getViewIsHidden()` (`view-state.ts`) for the zoom root + visibility
prune. The mirrors are written in effects (`useSyncViewState`), never during render, so `OutlineEditor`
stays React-Compiler-eligible (a ref written during render bails the compiler on the whole function).

**Don't:**
- Pass `node`/`index` as props to `OutlineNode` (reintroduces the storm).
- Pass a fresh `commands`/callback object per render — the memo only pays off while those stay
  referentially stable.
- "Fix" it with a custom memo comparator that ignores `index` — a parent can't tell a deep
  descendant changed without recursing, so it freezes the subtree below it.
- Read `getTreeIndex()`/`getViewRootId()`/`getViewIsHidden()` *during render*, or re-add a mirror ref
  written during render — render must use the reactive React value; the getters are event-time only.

**The editor keeps its manual memos even though React Compiler is on.** react-doctor flags
`commands`, `pluginCtx`, `viewCtx`, `isHidden`, `filter`, and `navigateZoom` in `OutlineEditor` as
"redundant manual memoization." They are **not** — measured 2026-06-26 on a 300-node flat outline:
deleting all of them fans a single keystroke out from ~2 `OutlineNode` re-renders to ~600 (every
visible bullet). The reason is non-obvious: `commands` and `navigateZoom` get their referential
stability from `useMemo`/`useCallback` **inside the `useNodeCommands` / `useZoomNavigation` helper
hooks**, and the compiler **does not memoize across a custom hook's return boundary** — without the
manual memo the helper returns a fresh object every render, busting `OutlineNode`'s `memo`. (The
unminified build confirms it: `OutlineEditor` itself compiles, but `useNodeCommands` does not, so its
return is uncached.) Keep these memos; they are permanent accepted react-doctor findings. The fix is
**not** "let the compiler do it" — only inlining the helper hooks into the compiled component would
let the compiler reach them, a larger and riskier refactor with no user-facing benefit.

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
(the outline write path), `/api/kv` (plugin side-collections: tag colors, daily index), and
`/api/sync` (real-time outline reads). Each `/api` request is routed to the caller's **Durable
Object** (`UserOutlineDO`, `worker/outline-do.ts`), whose colocated **SQLite** holds that user's
entire outline plus the side-collections. Inside a per-user DO the `owner` column is gone — the DO
*is* the scope — and its single thread serializes a user's edits across devices, so there is no
last-write-wins reconciliation.

**Nodes sync live over WebSocket.** `collection.ts` is a TanStack DB *custom sync* collection
(`realtime.ts` → `/api/sync`): on connect the DO sends a `snapshot`, then every mutation on any
device arrives as a `{type:'change', seq, ops}` delta — no window-focus refetch. **Field** writes
PATCH `/api/nodes` optimistically and the socket echo reconciles idempotently; **structural** writes
go through one atomic batch instead (see [Atomic structural writes](#atomic-structural-writes)). Reconnect
sends `hello{since}`; the DO replies with `resume` (changelog gap) or falls back to `snapshot`.
The DO uses **WebSocket Hibernation** (`ctx.acceptWebSocket`, never legacy `ws.accept()`) — idle
connections bill $0 duration; outgoing broadcasts are free. **Side-collections** (tag colors,
daily index) stay query collections over `/api/kv` and still reconcile on tab focus.

**The DO routing key must never be an email.** A DO name is *permanent* (no rename), so keying it
off a mutable value would orphan a user's whole outline on an email or auth-provider change.
`resolveUserId()` returns the session's stable **`session.user.id`** (the lone exception is the
owner-continuity bridge, which maps one configured account back to the `'default'` DO — see [the
auth gate](#the-auth-gate)). Do NOT "fix" it to route off the email; that reintroduces exactly the
orphaning this avoids.

**D1 is kept, but demoted — it is no longer the outline store.** It serves two roles: (1) the home of
**Better Auth's identity tables** (`user`/`session`/`account`/`verification`; see [the auth
gate](#the-auth-gate)), and (2) the **source for the one-time, non-destructive import** of the
owner's pre-DO rows into the `'default'` DO (`ensureSeeded` reads D1 on the owner's first
`/api/sync` connect — a GET upgrade; the DO marks itself `seeded` and never re-imports). The
`migrations/` SQL files (and `db:migrate:*`) still apply to that D1; the DO's own schema (including
the realtime `changelog` table) is created in its constructor via `CREATE TABLE IF NOT EXISTS`, so
it has **no SQL migration file** — its wrangler migration is the `new_sqlite_classes` tag.

**Why a DO over D1-direct, or ElectricSQL/Postgres?** The browser can reach neither D1 nor a DO
directly — both are Worker bindings, so any of them needs the server tier. A per-user DO *also*
gives colocated storage (sub-ms reads next to compute), a single-writer thread that removes
conflict reconciliation, WebSocket Hibernation for live fan-out, and the natural home for subtree
sharing. Electric gives real-time out of the box but isn't Cloudflare-native (must be hosted
elsewhere) — off-goal for an all-Cloudflare deploy.

**The SPA / no-SSR constraint lives here too:** the React app is a pure static SPA — never open the
sync socket or touch `nodesCollection` during a server/render pass (`collection.ts` guards with
`typeof window`; the tree store skips its subscription on the server; hooks supply
`getServerSnapshot` so `/` prerenders cleanly).

**Don't:** key the DO off an email/owner (permanent-name orphaning); reach for ElectricSQL or a
separate Postgres backend (off the all-Cloudflare goal); try to query D1 or a DO from the client
(impossible — both are Worker bindings); use legacy `ws.accept()` on the DO (bills duration for the
whole connection lifetime — the budget trap); have a snapshot return a *partial* node set (the
collection truncates on snapshot); or extract a generic `createKvCollection<T>` factory for
side-collections — each must pass its **concrete** zod schema inline, or schema inference falls
through to `Record<string, unknown>`.

---

## Atomic structural writes

**The invariant.** Within any parent, the `prevSiblingId` chain must be total and acyclic: exactly
one head (`prevSiblingId === null`), every other child points at a present sibling, and following
the chain reaches every child once. `buildTreeIndex` rebuilds sibling *order* from this chain at read
time, so a broken chain (a **fan** — two siblings sharing one prev; a **dangle** — a pointer to a
deleted/foreign id) silently orphans nodes: they render but can't be reordered, and it survives
refresh because the bad pointers are persisted. (Real bug: Jam `4b88ccae`.)

**The tear it fixes.** Maintaining the invariant on an insert/delete needs ≥2 nodes touched together
(insert a node **and** repoint its follower; delete a node **and** repoint its follower). The naive
path tears that apart: TanStack DB routes inserts → `onInsert` → POST and updates → `onUpdate` →
PATCH — two requests, two DO `commitChange`s, two `seq`s, two broadcast frames. A dropped half, or a
fast follow-up edit computed against the half-applied state, persists a fan/dangle. (Update-only ops
— moves, indent/outdent — were always one PATCH = one frame, which is why *reordering* never
corrupted; the damage clustered in create/delete-heavy areas.)

**The cure — `runStructural` (`structural.ts`), two properties, both required:**
- **P1 (atomic):** wrap every tree-shape edit so all its `nodesCollection.insert/update/delete`
  calls join ONE `createTransaction`, whose `mutationFn` ships them as a single `persistBatch` →
  POST `/api/nodes {ops}` → the DO's `applyBatch` → one `commitChange` → one frame. All-or-nothing.
- **P2 (hold-until-echo):** the transaction's `mutationFn` awaits `waitForSeq(seq)` — it does not
  resolve until the batch's own change frame echoes back. This is **load-bearing, not belt-and-
  suspenders:** a `createTransaction` op (unlike a direct `collection.update`, which TanStack DB
  marks a *direct* transaction and retains after completion) has its optimistic overlay **dropped on
  completion unless its echo has already landed** (`recomputeOptimisticState`, `state.js`). Without
  the wait the view would briefly revert to pre-op, and a fast follow-up edit would re-create a fan.
- **P3 (serialize on the wire):** `persistBatch` (`api.ts`) chains every batch POST off the previous
  one's response (`batchTail`) so the DO receives rapid batches in client-call order. P1/P2 keep the
  *local* state consistent, but two quick edits open independent transactions whose `mutationFn`s
  fire **concurrent** fetches — and separate requests have no ordering guarantee (HTTP/2 muxing). The
  DO stamps each frame's `seq` in arrival order, so a later batch landing first would let its repoint
  of a shared follower be overwritten by the earlier batch's stale one — a persisted fan, the exact
  bug, despite atomic frames. Serializing makes logical order == persisted order; the overlay is
  already on screen so the added round-trip is invisible.

**The structural-vs-field split is deliberate.** Only tree-shape ops route through `runStructural`
(insert/indent/outdent/move/reparent/remove, history undo/redo restore, the daily get-or-create).
**Field edits stay direct** (`setText` per keystroke, `toggleCompleted/Collapsed`, `setIsTask`,
`toggleBookmark`): each is a single-node, single-field PATCH = already one frame, and the
per-keystroke text path **must not** await an echo. (Direct ≠ unguarded: field PATCHes are still
serialized + coalesced on the wire and the focused bullet ignores echo-driven repaints — see *Field
edits: serialize, coalesce, ignore echoes on the caret*.) `runStructural` self-guards nesting
(`getActiveTransaction`) so a compound flow that calls it twice still emits one frame.

**Defense in depth, kept:** `healSiblingChains` (`collection.ts`) still repairs any persisted
corruption on snapshot load (pre-fix data still exists in users' DOs; cheap and idempotent), and a
DEV-only invariant tripwire in `runStructural` `console.error`s if an op ever leaves a touched
parent's chain broken.

**Don't:** route field edits through `runStructural` (per-keystroke echo-await = janky typing);
remove the `waitForSeq` ("the POST already returned 200") — that reintroduces the revert window;
unserialize `persistBatch` ("each batch is atomic, so order doesn't matter") — concurrent batches
can reach the DO out of order and persist a fan (P3); split a structural op's writes back into
per-type handler calls (the original tear); or drop `healSiblingChains` until the tripwire has been
silent in prod for weeks.

---

## Field edits: serialize, coalesce, ignore echoes on the caret

**The symptom.** Typing into a bullet scrambled characters and jumped the caret mid-word — the
outline felt unusable under fast input. (Real report: "characters jumble up while I'm typing.")

**The mechanism.** A field edit is direct (`setText` → `nodesCollection.update` → `onUpdate` →
PATCH), one transaction PER KEYSTROKE, and the bullet is a manually-managed `contentEditable` whose
store-sync effect repaints the DOM whenever `node.text` differs from what it last wrote. The
per-keystroke text path is correct in isolation but exposed to the same two races `runStructural`
closes for structural writes — only here they land on the DOM you're actively typing into:
- **Out-of-order persistence (the field-edit twin of P3).** Each keystroke fires its own PATCH, and
  separate fetches have no ordering guarantee (HTTP/2 muxing, Worker dispatch). `PATCH("ab")` can
  reach the DO *after* `PATCH("abc")`; last-writer-wins persists the stale `"ab"` and broadcasts it
  as the newest `seq`. The echo overwrites the live row with older text and the `"c"` is lost — and
  it survives refresh. This is genuine data loss, not just a flicker.
- **The overlay/echo gap (the field-edit twin of P2).** A direct `collection.update` overlay drops
  on the PATCH's HTTP ack, which is a *separate* channel from the WS echo that carries the same text.
  If the ack lands first, the readable value momentarily falls back to the synced base (an older
  echo), the sync effect repaints the focused bullet to that stale text and re-clamps the caret, then
  the echo arrives and it snaps forward. That round trip is the visible scramble.

**The cure — two independent halves, both shipped:**
- **Serialize + coalesce the field PATCH (`api.ts`, `updateNodes`).** Mirrors `persistBatch`'s
  `batchTail`, plus coalescing: while a PATCH is in flight, every later field change MERGES into a
  pending map (field-wise last-write-wins — correct because a PATCH carries only changed columns),
  and when the in-flight request returns the merged latest flushes as ONE ordered PATCH. Order is
  guaranteed (one request at a time), so the out-of-order race is gone. **This is also the cost
  lever:** a burst of N keystrokes costs ~1 Worker+DO round trip per RTT instead of N — a 40-char
  bullet bills a handful of requests, not 40. There is **no artificial debounce latency**: the
  optimistic overlay is already on screen, and we only ever batch what is already in flight.
- **Ignore echo-driven repaints on the focused bullet (`collection.ts` `echoedText` + `OutlineNode`
  store-sync effect).** The sync path records the last server-echoed text per node (`echoedTextFor`).
  While THIS bullet is focused the `contentEditable` is the source of truth, so the effect skips its
  repaint when the incoming `node.text` equals that last echo — i.e. the network reflecting your own
  (possibly stale/out-of-order) keystrokes back. The discriminator works because a LOCAL change
  (undo/redo restore, a slash insert) writes a value that does NOT match the latest echo and so still
  repaints; the echo only matches AFTER the local change has itself echoed. Reconciliation for the
  skipped case resumes on blur (`onBlur` re-reads the DOM).

**This does NOT walk back "field edits must not await an echo."** The overlay still drops on the
PATCH ack (snappy typing, no `waitForSeq`); the focused-bullet guard is what makes the surviving
ack/echo gap harmless, instead of holding the transaction open per keystroke. Field edits stay
*direct* (they never join `runStructural`) — they are now serialized and coalesced, not made atomic
or echo-held.

**Don't:** send one PATCH per keystroke again ("each field edit is already one frame") — true
per-call, but rapid calls race out of order and bill one DO write per character; debounce the text
PATCH on a timer (adds latency and can lose the last edit on unload — coalescing gets the same
savings with neither); or remove the focused-bullet echo guard ("the store is the source of truth")
— it is, except for the one node whose caret the user owns, where repainting an echo is the scramble.

---

## The auth gate

Identity is **Better Auth** (`worker/auth.ts`): email + password self-serve signup, sessions in D1.
Better Auth's `user` table IS the global identity store and `user.id` is the stable, permanent key
the Worker routes each user's outline Durable Object by. The Worker builds auth **per request**
(`createAuth(env)`) because the D1 binding only exists inside `fetch` — it cannot be a module
singleton.

**The shell is public; only the data API is gated.** The Worker serves the static SPA (so the login
screen can load) and `/api/auth/*` (Better Auth's own handler) without a session; `/api/nodes` and
`/api/kv` require a valid session (`auth.api.getSession`) and 401 otherwise. The client gates the
editor behind `useSession()` (root `AuthGate`) and shows the login screen when signed out. This
**replaced** the old three-tier `authorize()` (Cloudflare Access + localhost + HTTP Basic Auth, in
`git log`): Access can't do public self-serve signup, which a multi-tenant product needs.

**Owner-continuity bridge.** The pre-auth outline lives in the constant `'default'` DO (seeded from
legacy D1). Setting the `OWNER_USER_ID` secret to the owner's `user.id` maps that one account back
to `'default'`, carrying their existing data over with **zero copy** — everyone else routes to their
own `user.id` DO. `ensureSeeded` (the legacy D1 import) therefore runs only for the `'default'` DO;
new users start empty. Removable once that data is wherever it belongs.

**node:crypto** — Better Auth needs it, so wrangler sets `compatibility_flags: ["nodejs_compat"]`.

**Known gap (v1):** no email-verification requirement — no transactional email is wired yet, so
`requireEmailVerification` is off. Harden when an email sender (e.g. Resend) lands.

**Don't:** key the DO off the email (permanent-name orphaning — use `user.id`); make `createAuth` a
module singleton (the D1 binding is request-scoped); gate the static shell (the login screen must
load); or relax the `/api/*` session check to trust a client-supplied id.
