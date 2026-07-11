# Research: Workflowy search operators

Gathered 2026-07-10 as raw material for designing Dotflowy's filtering/search experience.
Sources: [official help docs](https://workflowy.com/help/search/), [Smooth Operators (blog, Dec 2021)](https://blog.workflowy.com/smooth-operators/), [Hidden Search Operators (tumblr, 2012)](https://www.tumblr.com/workflowy/32236484775/hidden-search-operators), [New Ways to Search (blog)](https://blog.workflowy.com/new-ways-to-search/), [Aug 2023 product update](https://blog.workflowy.com/product-update-august-29-2023-filter-by-creation-date-sidebar-keyboard-shortcut-mirror-and-boards-slash-commands-minor-fixes/), [Colors](https://workflowy.com/help/colors).

## 1. Boolean / logic operators

| Operator    | Syntax               | Behavior                                                                                                                                                             |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AND         | space between terms  | `a b` matches items containing both. The implicit default.                                                                                                           |
| OR          | `a OR b` (uppercase) | Either term. Example from docs: `@Steve OR @Lisa`.                                                                                                                   |
| NOT         | `-term`              | Excludes. Works on plain text, tags, and operators: `-#high`, `-is:complete`. A search of ONLY negated terms filters the current view (acts as "everything except"). |
| Exact match | `"quoted phrase"`    | Exact string match; default matching is partial + fuzzy. Also used for numeric substrings (`"203"`).                                                                 |

No parentheses/grouping documented. Precedence is undocumented (community consensus: OR binds the two adjacent terms; everything else is AND-ed).

## 2. Hierarchical (nested) search — the `>` operator

- `A > B` filters items matching B whose **ancestor** matches A. Chainable: `#high > SEO > @sam`.
- Each side supports full search syntax (multiple words, operators, negation): `Projects > Write draft -today`.
- Spaces around `>` are REQUIRED (`A>B` does not work).
- This is the killer operator: it lets a flat global search express "tasks under this project" without zooming first.

## 3. Type/state operators

### `is:` — item type or state

Documented values:

- `is:complete` — completed items
- `is:shared` — items you have shared
- `is:sharedwithme` / "shared with you" (autocomplete-surfaced)
- `is:mirror` — mirrors
- `is:backlinks` — items that are backlinks
- `is:embedded` (from the 2012 hidden-operators post; era-specific)

### `has:` — items containing a component

Documented values: `has:note`, `has:file`, `has:image`, `has:video`, `has:tweet`.
(Community has long requested `has:date`, `has:link`, `has:children` — not shipped as of the docs.)

### `in:` — where in the item the match lives

- `in:note:` — restrict match location (values: `note`, `backlink`). Lets you distinguish "text in the bullet" from "text in its note".

## 4. Formatting operators

### `text:` — text styling, formatting, or color

- Formats: `text:bold`, `text:italic`, `text:underline`
- Meta: `text:colored`, `text:highlighted`
- Colors: red, orange, yellow, green, teal, sky, blue, purple, pink, gray (Workflowy's fixed palette)

### `highlight:` — highlight color

- Same color palette as `text:`; `highlight:red` etc.
- Positioned in marketing as "bring paper highlighter workflows into the app": highlight errors while proofreading then filter to them, color-code study notes by information type, color tasks by day of week.

## 5. Time operators

| Operator                     | Syntax                               | Behavior                                                                                                      |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `last-changed:` / `changed:` | `last-changed:1d`, `last-changed:4h` | Items modified within the window. Units: days (`d`), hours (`h`). `changed:` is the current spelling in docs. |
| `created:`                   | `created:1d`                         | Items created in the window (added Aug 2023).                                                                 |
| `date-after:`                | `date-after:MM/DD/YYYY`              | Items whose **date tag** is after the given date.                                                             |

## 6. Date search (matches date _tags_ in content)

- Specific: `MM/DD`, `MM-DD`, `MM/DD/YY`, `MM-DD-YY`, `MM/DD/YYYY`, `MM-DD-YYYY` (HH and mm also tokenized).
- Natural language: `Today`, `Tomorrow`, `Yesterday`, `This/Next/Last week`, `This/Next/Last month`, `This/Next/Last year`.
- Ranges: `MM/DD - MM/DD` (and the YY/YYYY variants).
- These match Workflowy's structured date objects, not raw text.

## 7. Tags

- `#tag` and `@mention` are both first-class searches; typing one in the search box filters to it. Clicking a tag anywhere runs a search for it.
- Tags combine with everything: `is:complete @jesse last-changed:7d`.

## 8. UX around the operators (as important as the grammar)

- **Live filtering**: results update in real time as you type; the outline collapses to matches shown **with their ancestor chain as context** (non-matching ancestors are dimmed). Search never mutates expand/collapse state.
- **Scoped to zoom**: searching while zoomed searches within the zoomed node — zoom is the coarse filter, search refines it.
- **Autocomplete/discovery**: clicking the search bar (or ESC) opens a widget that lists the operators; typing `is:`/`has:`/`text:`/`highlight:` pops a value autocomplete. This is how "hidden" operators became discoverable.
- **ESC** focuses search; ESC again clears it.
- **Starred/saved searches**: a search (with operators) can be saved and given a custom name — effectively named smart views ([custom search names](https://blog.workflowy.com/custom-search-names/)).
- **Expand while searching**: you can expand/collapse within result sets.
- **Partial + fuzzy by default**, quotes opt into exact.

## 9. What Dotflowy already has that maps onto this

Almost every operator has an existing data-model analog — the grammar is missing, not the data:

| Workflowy                         | Dotflowy today                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `#tag` search                     | tags plugin: `?q=#a #b` URL filter, AND-only, click-driven, zoom-scoped (Seam G `buildTagFilter`)   |
| `is:complete`                     | `completed` field; todos plugin hide-completed transform                                            |
| todo/bullet/paragraph type        | `isTask` + `kind` fields (ADR 0045) — Workflowy has no type operator this granular                  |
| `is:mirror`                       | `mirrorOf` field                                                                                    |
| `is:backlinks`                    | `TreeIndex.linksByTarget` (ADR 0032)                                                                |
| `highlight:color`                 | `==🔴text==` color-in-source (ADR 0035), same 6-color idea                                          |
| `text:bold` etc.                  | emphasis tokens `**b**` `*i*` `~u~` `~~s~~` parsed from text                                        |
| date search                       | `[[YYYY-MM-DD]]` date tokens (ADR 0038) + daily-index side-collection                               |
| `has:link` (requested, unshipped) | `[label](url)` links parsed from text — we can ship what they couldn't                              |
| `created:`/`changed:`             | not stored today — no createdAt/updatedAt on `Node` (would be a wire-schema change)                 |
| `is:shared`                       | no sharing yet                                                                                      |
| `has:note`/`in:note`              | no notes-on-nodes concept                                                                           |
| provenance                        | `origin` field (agent vs human) — a filter axis Workflowy doesn't have                              |
| `A > B` nested search             | nothing — but zoom-scoped `?q=` covers the common case; `TreeIndex` makes ancestor predicates cheap |
| saved searches                    | bookmarks are saved _zoom views_ (`bookmarkedAt`); a saved _query_ would be the analog              |
| fuzzy text search                 | Cmd+K Fuse over `flattenInline` text (navigation, not filtering)                                    |

Key structural difference to keep in mind: Dotflowy's filter (`?q=`) is a **view transform on the zoomed tree** (URL-driven, render-time, never mutates collapse state) while Cmd+K is **navigation**. Workflowy fuses both into one search box. Any operator grammar we add naturally extends the existing `?q=` + `buildFilter` seam (Seam G), and the tags plugin already owns that stack.

## 10. Gaps/open questions for the design pass

- Grammar: extend `?q=` from "space-separated `#tags`" to a real operator grammar (parser lives where — `src/data/tags.ts` is tags-only today; a filter grammar is arguably core, like markdown-import).
- Which axes first: type (`is:todo|paragraph|bullet|complete|mirror`), tag, highlight color, has:link, date — all already answerable from `node.text` + fields with zero migrations.
- `created:`/`changed:` need timestamps on `Node` (wire-schema + DO migration + fixtures checklist) — the only axis that costs a migration.
- Discovery UX: Workflowy's operator autocomplete widget is the reason the operators get used. Our equivalents: the subheader filter bar (tags plugin), Cmd+K, or a search-bar autocomplete like the `#`/`[[` caret menus.
- Saved searches: natural extension of bookmarks (a bookmark that carries a `?q=`).
- Negation + OR: today's tag filter is AND-only.
