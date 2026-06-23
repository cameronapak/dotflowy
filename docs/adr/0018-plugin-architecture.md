# ADR 0018: Plugin architecture (a beautiful core, extended by plugins)

Status: **partially implemented** (2026-06-23) — shaped in a `/grill-with-docs` session; design
decisions **D1–D10** are settled and ratified (D9 + D10 included). The plugin **host** (D1/D5/D6/D8)
and Seams **A** (inline tokens), **B** (delegated interaction), and **I** (paste) are **built and
dogfooded**: `code`/`links`/`tags` are plugins in `src/plugins/`, with **links a complete plugin**
(A+B+I). Remaining: Seams **C/D/F/G/H** and the **todos** plugin (incl. the D9 completion-ownership
move) — they need the hot-path view-transform/store refactor and a menu engine. See *Implementation
status* below.

Relates to:

- [ADR 0014](./0014-localized-node-rendering-via-tree-store.md) — per-node subscriptions and the
  "no index/`node` props" rule. Any plugin that touches rendering inherits this hot-path constraint.
- [ADR 0015](./0015-tag-filtering.md), [ADR 0016](./0016-custom-tag-colors.md) — tags: the
  parsed-from-text decorator + delegated click + URL filter + side-collection. The richest single
  feature to "reduce to a plugin," because it spans the most seams.
- [ADR 0017](./0017-rich-links.md) — rich links: the one decorator that *folds* (source ≠ display),
  the deepest coupling into the caret machinery.
- [ADR 0001](./0001-completion-is-independent-of-task.md), [ADR 0005](./0005-no-zod-defaults-in-schema.md),
  [ADR 0011](./0011-bookmarks-via-header-popover.md) — todos/completion: the one feature here that
  owns **stored schema fields** (`isTask`, `completed`), which is where the hard data-ownership
  question lives. **D9 partially supersedes ADR 0001 and ADR 0002** — completion's *behavior* is
  unchanged but moves from core into the todo plugin (see *Decision*).

## Glossary

- **Seam** — a single, named place the core can be extended. This ADR's claim is that Dotflowy has
  a *small, finite* set of seams (below), and "a plugin" is a bundle that registers into some
  subset of them. Not a generic "plugin can do anything" surface.
- **Plugin** — a bundle of registrations against the seams, **compiled into the app** (an internal
  registry — D1), authored locally in `src/plugins/<name>/`. *Not* runtime-loaded after install
  (zenbu's claim) — that's the deferred door.
- **Decorator / token** — an inline construct parsed out of `node.text` and rendered as HTML
  (`` `code` ``, `#tag`, `[label](url)`). All three share one compiled regex pass (`TOKEN` in
  `inline-code.ts`) and one `decorate()` call site. Code/tags keep source length == display length;
  links fold. See *Seam A*.
- **Stored field** — a persisted property on the `Node` (`isTask`, `completed`, `bookmarkedAt`).
  Adding one is a schema change + a localStorage backfill (ADR 0011's `migrateAddBookmarkedAt`) and
  must follow ADR 0005 (no zod defaults). Todos are the only one of the three features that needs
  this. See *Seam E*.
- **Side-collection** — a separate TanStack DB collection keyed by node id (`tagColorsCollection`),
  data that rides alongside nodes without touching the node schema. The clean-uninstall path for
  plugin-owned data. See *Seam E*.
- **"Extensible by default"** — zenbu's thesis (as inferred from its docs' page set, not its prose):
  because everything flows through dependency **Injection** + aspect-oriented **Advice**
  (before/after/around) + **Events** over **Services**/**Views**, any unit can be advised, replaced,
  or observed *without the original author designing a plugin API up front*. App code is itself a
  plugin. Elegant for an Electron multi-process host; heavy to graft onto a contentEditable SPA.

## The seams Dotflowy actually has

The three features are **not symmetric**. They decompose into a shared, finite set of seams; each
feature lights up a different subset. This table is the spine of the whole ADR.

| Seam | What it is (today) | tags | todos | links |
| ---- | ------------------ | :--: | :---: | :---: |
| **A. Inline token + decorator** | `TOKEN` regex + `inlineMarkupHtml`/`decorate` in `inline-code.ts` | ✅ | — | ✅ (folds) |
| **B. Delegated interaction** | `onContentMouseDown/Click/ContextMenu` on `[data-*]` spans (OutlineEditor) | ✅ filter / color | — | ✅ open |
| **C. Command registry** | the `SLASH_COMMANDS` array (`slash-menu.tsx`) | — | ✅ to-do/bullet | — |
| **D. Keyboard map** | per-bullet `useHotkeys` (OutlineNode) + editor-level hotkeys | — | ✅ Cmd+Enter | — |
| **E. Stored data** | `Node` schema field (migration) *or* a side-collection | color side-coll. | ✅ `isTask`/`completed` | — |
| **F. Row render slot** | elements in `.outline-row` (the checkbox before `.node-text`) | — | ✅ checkbox | — |
| **G. View transform** | render-time tree prune (`buildTagFilter`, `showCompleted`) | ✅ `?q=` filter | ✅ show-completed | — |
| **H. Autocomplete menu** | `#`/`/` caret menus (`tag-menu.tsx`, `slash-menu.tsx`) | ✅ `#` | ✅ via `/` | — |
| **I. Input transform** | paste / autoformat (`paste-links.ts`, `[]`→task) | — | ✅ `[]` autoformat | ✅ paste-to-link |

Reading it: **links** are almost entirely Seam A+B (text in, decorate, click) — the cleanest to
plug. **tags** span A+B+E+G+H — the broadest. **todos** are the odd one out: they own a **stored
schema field** (E) and a **render slot** (F) and don't touch the tokenizer at all — they're the
feature that forces the hard questions about plugin-owned data and DOM slots.

So "reduce X to a plugin" = "expose these seams as typed registration points, then re-implement
X as a bundle of registrations." The design work is naming the seams and their contracts, not
inventing a runtime.

## The fork that decides everything

Two very different things wear the word "plugin," and the whole architecture hinges on which one:

1. **Internal extension registry.** Typed seams; plugins are modules compiled into the bundle; the
   `SLASH_COMMANDS`-style array generalized to all nine seams. Lets you (or an AI agent working *in
   the repo*) add features without spaghetti. Cost: ~a refactor.
2. **Runtime third-party plugins.** Code loaded *after install* to modify a running app — zenbu's
   actual claim. Needs a module loader, a sandbox, a capability/permission model, plugin-owned
   persisted data with versioning, and a stable public API surface. Cost: a new platform.

**Resolved → #1** (D1): internal registry, contributor-authored locally; driver is (c) keeping the
core clean. #2 is the deferred door (*Rejected alternatives*, *Deferred*).

## Decision

Promoted so far (the grilling continues below them):

- **D1. Internal registry, contributor-authored (the fork → #1).** Plugins are modules **compiled
  into the bundle**; contributors author them locally in-repo. No runtime/after-install loading, no
  sandbox, no capability model in scope. The driver is **(c): keep the core clean as features
  accrete**. zenbu's *idea* (extensible-by-default seams) is adopted; its multi-process /
  dynamic-compilation machinery is not — Dotflowy is a Vite SPA, not an Electron host.

- **D2. Two-tier data ownership.**
  - **Core primitives** — data any *core view-transform* must read (completion, ordering, collapse,
    text) stay on the `Node`. A plugin may *expose and drive* a primitive but does not *own* its
    storage. **Todos stay here:** `completed`/`isTask` remain node fields; the "todo plugin" owns the
    *interaction surface* (checkbox slot, Cmd+Enter, `/todo`, `[]` autoformat, the show-completed
    toggle), **not** the storage. Reason: show-completed filtering and fade-inheritance are *core* and
    must read `completed`; moving it into a plugin collection inverts the dependency (core → plugin).
    **(Refined by D9:** the `completed`/`isTask` *fields* stay node slots for hot-path speed, but
    their *meaning, transforms, and UI* move into the todo plugin — a **plugin-owned core-reserved
    slot**.)
  - **Plugin-private data** — data only the plugin reads (tag colors, a hypothetical due-date) →
    **side-collection keyed by node id**, exactly like `tagColorsCollection`. No schema change, clean
    uninstall, rides the sync path. Prefer a non-React paint path (generated stylesheet /
    `data-*` attributes, as tag-colors does) for hot-path visuals; a per-node subscription is allowed
    for non-hot-path UI.
  - **The decider test:** *does any core view-transform (show/hide, fade, sort, breadcrumb) need this
    field?* **Yes → core primitive. No → side-collection.** Plugins do not add new core primitives in
    v1 — that stays a governed core-schema decision (its own ADR).

- **D3. Declarative tokens, not per-keystroke code.** A token plugin *declares* `{ pattern, render }`
  where `render` returns **structured data**, not an HTML string and not arbitrary per-keystroke
  code. The core keeps one compiled `TOKEN` pass and ADR 0014's per-node speed, and **owns escaping**
  (so the trust question D collapses — a plugin never hands the core raw HTML).

- **D4. Migration order.** **Links first** (pure Seam A+B — proves the decorator), then **tags**
  (proves side-collection + filter + menu), then **todos** (proves the core-primitive + render-slot
  path). Each feature is the acceptance test for the seams it lights up.

- **D5. Plugin shape + wiring.** One plugin per `src/plugins/<name>/index.ts`, default-exporting a
  single `definePlugin({ id, tokens?, commands?, keymap?, slots?, interactions?, collection?, ... })`
  object that registers into whatever seams it needs. Wiring is **one explicit array** —
  `src/plugins/index.ts` → `export const plugins = [code, links, tags, todos]` — not
  `import.meta.glob` auto-discovery. Greppable, ordered (ordering feeds D7), no magic for a
  contributor reading cold. Adding a plugin = add a folder + one line in that array. **Dogfooded
  (D-G):** `code`/`links`/`tags`/`todos` are themselves entries in this array, built on the same
  public API — so the core *cannot* accrete feature-specific branches.

- **D6. Token contract — fragments composed into one pass; render returns structure, not HTML.**
  - A token plugin contributes a **regex *source fragment*** (a string), not a standalone `RegExp` it
    runs itself. The core composes all fragments into the **single** combined `TOKEN` regex
    (alternation, one compiled `matchAll` pass), preserving today's one-pass hot path. N plugins do
    **not** mean N scans.
  - `render(match, view)` returns an **element-descriptor tree** (a tiny hyperscript:
    `string | { tag, attrs?, children? }`), never an HTML string. The **core** escapes text and
    serializes attributes — so the trust/escaping question (old D) cannot arise from a plugin. `view`
    carries `{ revealOffset }` (the caret's source offset, null when blurred) so a *folding* token
    (links) decides reveal-vs-fold.
  - **Folding is already generic.** The caret machinery (`readSource`, `getCaretOffset`,
    `setCaretOffset`, `sourceOffsetUpTo`) keys atomic-widget handling on the **`data-src` /
    `data-src-len`** attributes, *not* on "link" — only `isFoldedLink`'s extra `data-link` check and
    the renderer's char-code dispatch are link-specific. So a token declares folding by emitting one
    atomic element (`contenteditable="false"`, `data-src` = its full source); the existing caret code
    counts it correctly with **no per-token special-casing**. Generalizing links → "any folding
    token" is mostly renaming `data-link` to a generic marker. This is the unlock that makes D6 cheap.

- **D7. Ordering & conflicts.**
  - **Tokens:** an integer `precedence` orders the alternation branches (lower = matched first on an
    overlapping span — today `link < code < tag`, so a link's interior stays opaque); ties break by
    array order (D5). Matches are non-overlapping (one left-to-right `matchAll`).
  - **Slash commands:** concatenated in plugin-array order; no hard conflict (they coexist, filtered
    by query).
  - **Keymap:** additive shortcuts only, over a **reserved-key denylist the core owns** — the
    structural editing keys (`Enter`, `Tab`, `Shift+Tab`, `Backspace`, `Arrow*`, and the move/zoom
    combos) are **core-sacred and cannot be rebound by a plugin**. A collision *between plugins* on a
    non-reserved key **throws at registration in dev** (loud — you want to know two plugins fight over
    `Cmd+Enter`), first-in-array wins in prod. (Reserved set ratified in *Open questions → K*.)

- **D8. PluginContext = the promoted `NodeCommands`.** This is **not** a from-scratch API. The slash
  registry already hands each command `run(nodeId, commands: NodeCommands)`; the plugin surface is
  that object, formalized and frozen, plus read access to the tree store and navigation. A plugin's
  `run` / `onClick` receives a `PluginContext` ≈ `{ tree (readonly index), mutations (the
  `NodeCommands` set), nav: { zoom, navigate, filterTag, setSearch }, search (current `?q=`) }`. New
  capabilities are added here deliberately, versioned with the surface.

- **D9. Completion is the todo plugin's concept (partially supersedes ADR 0001 / 0002).** A plain
  Dotflowy outline is just nestable text. **Completion — the `completed` state, `Mod+Enter` /
  `Mod+D`, the checkbox, hide-completed, and fade-inheritance — is granted by *installing the todo
  plugin***, not a universal core capability. Uninstall it and nothing is completable; there is no
  "done." Completion stays **universal once installed** (any bullet, not only checkbox tasks — ADR
  0001's spirit), but it's the plugin that makes nodes completable. This answers "should nodes be
  completable by default?" with **no — that's what the todo plugin is for.**
  - *Philosophy:* the todo plugin owns the field's meaning, the keymap (`Mod+Enter`/`Mod+D` — the one
    sanctioned place a plugin binds otherwise-reserved keys, *because it defines the capability*), the
    checkbox slot, `[]` autoformat, `/todo`, the **hide-completed view-transform**, and
    **fade-inheritance**.
  - *Pragma:* the `completed`/`isTask` **fields stay node slots** (not a side-collection) — a
    **plugin-owned core-reserved slot**. `useVisibleChildIds`/fade read them every render, and a
    per-node side-collection join on the hottest path isn't worth it. This is the **named exception**
    to D2's "no plugin fields on the node," justified by performance + the fields pre-dating plugins;
    core declares the column, exactly one plugin (todos) reads/writes it.
  - *Seam G is shared, not new v1 cost.* Hide-completed and the tag `?q=` filter are both
    render-time tree-prune view-transforms. Making tags a plugin (D4) already forces Seam G to exist;
    todos' hide-completed reuses it. The core store stops special-casing `completed` in
    `useVisibleChildIds`; completion-hiding and tag-filtering become two plugin-contributed Seam-G
    transforms — a convergence, not a second mechanism.
  - *Supersedes:* ADR 0001 (completion independent of task) and ADR 0002 (fade + show-completed) in
    **ownership only** — the behavior is unchanged; its home becomes `src/plugins/todos/`.

- **D10. Render shapes: React components for real trees; declarative descriptors for inline tokens.**
  "React components for everything" holds **everywhere a seam owns a real React tree** — row slots
  (the checkbox), menus, the filter bar, overlays return React components, full stop. The **one
  exception is inline tokens**, forced by the substrate, not preference: inline decoration renders
  *inside the manually-synced contentEditable that React deliberately does not control* (ADR
  0014/0017 — "contentEditable text sync is manual; don't convert to React-controlled").
  `decorate()` builds an HTML string and assigns `innerHTML` on the keystroke hot path (render cache
  + source-offset caret math on top). So a token returns a **declarative element descriptor** (D6),
  which the core escapes/serializes into that string; interactivity rides the **delegated
  data-attribute handlers** (Seam B), exactly as tags/links do today — a token "component" would
  have no state/hooks/events anyway. **Two render shapes, split by whether the seam owns a React tree
  or paints into the contentEditable string.** (Authoring tokens as static JSX via
  `renderToStaticMarkup` is *deferred* — it pulls `react-dom/server` onto the hot path and into the
  bundle. Forcing tokens through live React would mean the Lexical/ProseMirror substrate rewrite ADR
  0017 already rejected.)

## Open questions (the grilling)

Resolved → see *Decision*: ~~A (driver/fork)~~ → D1. ~~B (data ownership)~~ → D2. ~~C (hot path)~~ →
D3. ~~D (trust)~~ → folds out of D3. ~~F (v1 order)~~ → D4.

Resolved → see *Decision*: ~~G (dogfooding)~~ → D5/D-G. ~~H (shape + wiring)~~ → D5.
~~I (token contract)~~ → D6. ~~E (ordering/conflicts)~~ → D7. ~~J (PluginContext)~~ → D8.

Resolved → see *Decision*: ~~K (reserved keys / `Mod+Enter`)~~ → D7 + D9 (completion keys move into
the todo plugin, the sanctioned reserved-key binding). ~~L (render-slot shape)~~ → D10 (slots are
React components; inline tokens are descriptors). ~~M (doc completion)~~ → done (sections below).

Reserved-key denylist (ratified, D7): `Enter`, `Shift+Enter`, `Tab`, `Shift+Tab`, `Backspace`,
`Arrow{Up,Down,Left,Right}`, `Mod+Shift+Arrow{Up,Down}`, `Mod+Arrow{Up,Down}`, `Mod+.`. `Mod+Enter`
and `Mod+D` are **not** core-sacred — they belong to the todo plugin (D9).

Left for the implementation ADR (not this design): the exact `El` descriptor type, the `slots` key
names, `PluginContext` field-by-field, and the order the core store is refactored to read Seam-G
transforms instead of hardcoding `completed`.

## Implementation status

**Built (typecheck + Playwright green, incl. a new `e2e/tag-filter.spec.ts`):**

- **Host** — `src/plugins/types.ts` (the `definePlugin` contract), `src/plugins/index.ts` (the one
  explicit ordered array `[code, links, tags]`, D5), `src/plugins/registry.ts` (composes the seams
  from the array once at load). `El` is pinned as `string | { tag, attrs?, children? }` (D6/D10);
  `PluginContext` (D8) = `{ tree, mutations (NodeCommands), nav: { zoom, filterTag, setSearch },
  search, openOverlay }`.
- **Seam A (tokens)** — `inline-code.ts`'s `inlineMarkupHtml` is now registry-driven: plugins
  contribute regex fragments composed into ONE `gu` regex; `render` returns `El`; the core escapes +
  serializes (`serializeEl`). Folding generalized — `isFoldedLink` → `isAtom` (keys on `data-src`),
  and the reveal fast-path uses `hasFoldingToken`. `code`/`links`/`tags` token render all moved into
  their plugin folders; HTML output is byte-identical (the render cache + rich-links e2e confirm it).
- **Seam B (delegated interaction)** — `registry.blocksCaret`/`dispatchClick`/`dispatchContextMenu`;
  `OutlineEditor`'s three content-container handlers are now **fully generic** (zero feature
  knowledge). Links contribute open; tags contribute filter-on-click + color-on-right-click.
- **Seam I (paste)** — `paste-links.ts` → `paste.ts` (generic mechanics + plain-text baseline); the
  three URL/anchor cases are the links plugin's `input.onPaste`.
- **Overlay host** — `ctx.openOverlay(node | null)`, a thin portal mount in `OutlineEditor`; the tag
  color picker (moved to `src/plugins/tags/tag-color-menu.tsx`, Seam E side-collection) uses it.

So **links is a complete plugin** (its only seams are A+B+I), and **tags** is A+B+E.

**Remaining:**

- **Seam H** (`#`/`/` autocomplete) — generalize `tag-menu.tsx`/`slash-menu.tsx` into a core menu
  engine + plugin `menus` specs. Tags' `#` menu and the `/` palette are still core-wired.
- **Seam G** (render-time view-transforms) — the invasive one. The tag `?q=` filter is still
  computed in `OutlineEditor` and threaded as the `filter` prop; hide-completed is still hardcoded in
  `useVisibleChildIds`. D9 wants both expressed as plugin-contributed transforms — a hot-path
  (ADR 0014) store refactor that deserves its own careful pass.
- **Seams C/D/F + the todos plugin** — slash commands, the `Mod+Enter`/`Mod+D` keymap, the checkbox
  row slot, the `[]` autoformat, and (D9) moving completion's ownership out of core. Blocked on Seam G
  (hide-completed) landing first, since todos reuses it.

## Why

- **Internal registry over a runtime platform (D1).** The driver is (c) keeping the core clean, not
  after-install modding. zenbu's runtime story needs an Electron host + dynamic compilation +
  sandbox + capability model; on a Vite SPA those are all net-new platform code for a problem
  Dotflowy doesn't have. Adopt the *idea* (seams, "extensible by default"), skip the machinery.
- **Two-tier data, arrow points core → plugin (D2/D9).** Data a core transform reads stays a node
  slot; data only a plugin reads is a side-collection. Completion is the honest edge: its *behavior*
  is a plugin, its *field* stays core for speed — named explicitly (D9) rather than smuggled in.
- **Declarative tokens + one composed regex (D3/D6).** Preserves the single compiled pass and ADR
  0014's per-node render budget, and keeps escaping (XSS) in core hands. N plugins must not mean N
  scans or N trust boundaries.
- **Dogfooding (D-G/D5).** Building code/tags/links/todos on the public API is the only thing that
  keeps the API honest and the core un-accreted. If a core feature needs a private hook, the seam is
  incomplete — a bug to fix in the open, not route around.
- **Folding is already generic (D6).** The expensive caret math keys on `data-src`, not on links, so
  the scariest part of generalizing the decorator is already done.

## Rejected alternatives

- **Runtime / after-install / AI-authored-at-runtime third-party plugins (zenbu-literal).** A module
  loader + sandbox + capability system + plugin-owned persisted data with versioning, on a Vite SPA
  whose sync backend is still unsettled (Jazz vs Turso). Solves "modify an installed app," which is
  not driver (c). **Rejected for v1**; the separate, independently-justified door if a real
  third-party ecosystem appears — its own ADR.
- **Plugins extend the `Node` schema freely.** Migrations, the ADR 0005 default problem, sync-schema
  churn, orphan fields on uninstall. **Rejected** — plugin data is a side-collection (D2); the lone
  node slot is the perf-justified completion exception (D9), governed by core.
- **Per-keystroke plugin code in the decorator.** Arbitrary code per bullet per keystroke kills the
  one-pass / per-node budget and opens an escaping hole. **Rejected** for declarative tokens (D3/D6).
- **N independent token regexes.** Each plugin runs its own scan — O(N) passes over every line every
  keystroke. **Rejected** for one composed alternation (D6).
- **`import.meta.glob` auto-discovery.** Zero-friction but unordered and magic. **Rejected** for one
  explicit, greppable, ordered array (D5).
- **React everywhere, inline tokens included.** Forces `react-dom/server` onto the hot path or a
  contentEditable substrate rewrite (Lexical/ProseMirror). **Rejected** for the descriptor exception
  (D10).
- **Completion as a pure side-collection (full D2 purity).** Principled, but a per-node join on the
  hottest render path for a field that's already a cheap node boolean. **Rejected** for the
  plugin-owned core-reserved slot (D9).

## Deferred

- **Runtime / third-party / AI-authored-at-runtime plugins**, and with them sandboxing, capabilities,
  and a frozen public ABI.
- **Authoring inline tokens as static JSX** (`renderToStaticMarkup`) instead of descriptors —
  additive once the hot-path + bundle cost is judged worth the DX.
- **Moving `completed`/`isTask` to a side-collection** — once a cheap hot-path read for
  side-collections exists (an index, à la tag-colors' stylesheet trick).
- **Plugins adding new *core* primitives** (fields core transforms read) — stays a governed
  core-schema decision.
- **Seams the first three features don't need** — a settings/preferences seam, a toolbar seam,
  lifecycle beyond `register` + `migrate`.

## Appendix: the `definePlugin` surface (sketch, not final — the implementation ADR pins types)

```ts
// src/plugins/<name>/index.ts  — one default-exported plugin object.
// src/plugins/index.ts         — export const plugins = [code, links, tags, todos]  (D5: explicit, ordered)
export default definePlugin({
  id: "todos",

  // Seam A/B — inline tokens. Declarative: the core composes every plugin's
  // `pattern` into ONE regex and owns escaping. A folding token (links) emits a
  // single atomic element carrying its `src`; the caret math counts it (D6).
  tokens: [/* { id, pattern, precedence, render(match, { revealOffset }): El,
                onClick?(match, ctx), onContextMenu?(match, ctx) } */],

  // Seam C — slash commands (concatenated in array order, filtered by query).
  commands: [/* { id, label, description, icon, keywords, available, run(nodeId, ctx) } */],

  // Seam D — additive keymap over the reserved-key denylist (D7). Todos is the
  // one plugin allowed Mod+Enter / Mod+D, because it defines completion (D9).
  keymap: [/* { hotkey, when?, run(nodeId, ctx) } */],

  // Seam F — row render slots. REAL React components (D10).
  slots: { /* "row:before-text": ({ node, ctx }) => <Checkbox … /> */ },

  // Seam G — render-time view transforms (hide-completed, tag filter). Pure,
  // return the visible/match sets like buildTagFilter does today.
  transforms: [/* { id, build(index, rootId, params, ctx): ViewFilter } */],

  // Seam H — caret autocomplete menus ("#", "/").
  menus: [/* { trigger, items(query, ctx), onPick(item, ctx) } */],

  // Seam I — input transforms (paste, autoformat).
  input: { /* onPaste?(e, el, ctx), autoformat?: [{ pattern, run(nodeId, ctx) }] */ },

  // Seam E — plugin-owned side-collection keyed by node id (+ optional migration).
  // Omitted by todos (its data is the core-reserved node slot, D9); used by tag colors.
  collection: /* { name, schema, migrate? } | undefined */ undefined,
});

// El (D6):  string  (escaped text)  |  { tag, attrs?, children?: El[] }   — never raw HTML.
// ctx = PluginContext (D8): the promoted, frozen NodeCommands + reads + nav:
//   { tree /* readonly index */, mutations /* NodeCommands */,
//     nav: { zoom, navigate, filterTag, setSearch }, search /* current ?q= */ }
```
