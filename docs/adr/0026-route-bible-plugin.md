# ADR 0026: route-bible plugin (Scripture reference chips)

Status: accepted (2026-06-24), implemented. **Update:** the chip's CSS no longer
lives in core `styles.css` — it moved into the plugin's own `styles.ts` via the
plugin styles seam ([ADR 0027](./0027-plugin-styles-seam.md)). A new *consumer* of the
existing plugin seams ([ADR 0018](./0018-plugin-architecture.md)) — **Seam A**
(inline token + decorator) + **Seam B** (delegated interaction) — not a new seam.
It is to `route.bible` what the **links** plugin is to URLs: detect a construct in
`node.text`, chip it, open it on click. No `Node` schema change, no migration, no route.

## Glossary

- **Scripture reference** — a Bible citation written in `node.text` (`John 3:16`,
  `Genesis 1`, `1 Cor 13:4-7`). Parsed from text, **never a stored field** — same
  stance as `#tags` and links.
- **Reference chip** — the non-folding, clickable `Badge`-styled span a Scripture
  reference renders as. Its displayed text is the user's **verbatim** source; only
  the *link* it opens is canonicalized.
- **Resolver URL** — the `https://route.bible/...` link a reference opens, built by
  grab-bcv's `toResolverUrl` from the parsed passage.

## Decision

A `route-bible` plugin (`src/plugins/route-bible/`), registered as one more line in
the `plugins = [...]` array. The folder is **self-contained**: pure layer in
`bible.ts`, chip + interaction wiring in `index.tsx`, CSS in `styles.ts`. (Unlike
`tags`/`links`, whose pure layers still sit in `src/data/`, route-bible keeps
everything in its own folder — the "plugin as isolated package" direction; see
[ADR 0027](./0027-plugin-styles-seam.md).)

1. **Dependency: `grab-bcv` only — not `@route-bible/core`.** grab-bcv is the actual
   BCV parser (a transitive dep of `core`). It alone covers everything the chip needs:
   - `tryParsePassage(token)` — validate an isolated candidate against real
     chapter/verse caps (`John 99:99` → rejected) and return the parsed passage.
   - `toResolverUrl("https://route.bible", parsed, { query: { src: "dotflowy" } })` —
     build the route.bible link directly.

2. **Detection = loose regex *proposes*, parser *disposes* (Seam A).** The token
   `pattern` mirrors grab-bcv's own internal `REFERENCE_TOKEN_PATTERN` natural-text
   branch (copied — it is **not exported**):
   `(?:[1-3]\s*)?[A-Za-z]+(?:\s+of\s+[A-Za-z]+)?\s+\d+(?:(?::|\s)\d+(?:-\d+)?)?`.
   It **requires a chapter** (`\s+\d+`) so a book name alone never chips, and leaves
   the verse optional so a whole-chapter reference (`Genesis 1`) chips too — exactly
   the product rule. The regex over-matches (any word + a number); `render` runs the
   candidate through `tryParsePassage` and returns **plain text** when it doesn't
   parse, so `Hello 3` never becomes a chip.

3. **Non-folding chip (like a `#tag`, not like a link).** The chip is a plain
   `<span data-bible-ref data-href="…">` whose `textContent` **equals** the source —
   so the caret moves through it character-by-character and there is **no fold /
   reveal / caret-atom machinery** (the link plugin's complexity, ADR 0017, is
   avoided). The chip wears `Badge`'s outline look as a utility-class string (Seam A
   serializes an `El` to HTML — it can't render the `<Badge>` React component), the
   same way `tags` reuses the pill shape.

4. **Open on click (Seam B).** `selector: "span[data-bible-ref]"`,
   `blockCaretOnMouseDown: true`, `onClick` → `window.open(data-href)` in a new tab —
   the same delegated path links and tag chips use. The core keeps zero Bible knowledge.

Token **precedence ~15**: after links (0) and code (10), so a reference inside a
`[label](url)` or a `` `code` `` run stays owned by those; it does not overlap `#tags`.

## Why

- **grab-bcv over `@route-bible/core`.** `core` is route.bible's server/extension
  toolkit — QR codes, ICS calendar export, ingest/resolve adapters — and drags in
  `@route-bible/qr`, `@route-bible/adapters`, `@route-bible/contracts`. ~90% is dead
  weight for a click-to-open chip shipped to users on Cloudflare. grab-bcv is the lean
  parser underneath it and exposes both the parse gate and the URL builder. Lighter
  bundle, fewer transitive deps, same author's canonical URL format.
- **Loose-regex-plus-parser over a precise generated regex.** We *could* generate a
  book-name alternation from grab-bcv's `BOOK_ALIAS_TO_OSIS` to reject bad books in the
  regex itself. But that bloats the one combined Seam-A regex (hundreds of aliases) and
  duplicates validation grab-bcv already does. A small loose pattern + `tryParsePassage`
  gate is cheaper to carry and leans on the library's strength.
- **Liberal matching, tightened later if needed.** v1 keeps grab-bcv's liberal pattern
  as-is: case-insensitive (`john 3:16` chips) and a space-or-colon verse separator
  (`Psalm 23 5` parses as 23:5). Both admit false positives (`Matthew 5 minutes` →
  `Matthew 5`; `Psalm 23 5 times` → `Psalm 23:5`). Accepted for v1 by explicit call —
  start permissive, add constraints (require `:`, require a capital initial) only if the
  noise is felt in real use.
- **Non-folding over folding.** A reference's display and source are the same short
  string; normalizing the *display* to canonical buys little and would cost the entire
  link-style fold/reveal/source-offset machinery. The link still resolves canonically.

## Rejected alternatives

- **Depend on `@route-bible/core`.** The package the request named — rejected for bundle
  weight and transitive deps; grab-bcv (its own dependency) does the job. Reconsider only
  if route.bible's URL scheme outgrows grab-bcv's `toResolverUrl`.
- **Precise book-alias regex.** Rejected: bloats the combined regex and re-implements
  grab-bcv's book validation. The parser gate already filters invalid books.
- **Folding chip with canonical display** (link-style). Rejected: triples the complexity
  for cosmetic normalization of an already-short string.
- **Render the `<Badge>` component.** Impossible at this seam — token `render` returns a
  serialized `El`, not React. We reuse Badge's classes instead.
- **Strict v1 (require `:verse`, require capitalized book).** Considered and declined by
  the owner; liberal first, constrain later.

## Known rough edges / deferred

- **The detection pattern is copied from grab-bcv, not imported** (`REFERENCE_TOKEN_PATTERN`
  is internal). If grab-bcv tightens its parser, our *detection* pattern can drift from its
  *validation*. Low risk (the parser gate still rejects anything invalid); revisit if grab-bcv
  ships an exported scanner.
- **Liberal false positives** (`Matthew 5 minutes`, `Psalm 23 5 times`) are accepted, per the
  Why. The fixes (colon-required verse, capitalized initial) are one-line regex tightenings.
- **Translation is route.bible's default (BSB); no per-user choice in v1.** A configurable
  default would be a Seam-E side-collection (like tag colors, [ADR 0016](./0016-custom-tag-colors.md)) —
  deferred until wanted. `src: "dotflowy"` is sent for attribution.
- **No `#`-style autocomplete.** grab-bcv exposes `autocompletePassage`; a Seam-H menu
  (type `Joh` → suggest `John`) is a clean follow-up, not a v1 need.

## What it adds

- **`src/plugins/route-bible/bible.ts`** — `BIBLE_REF_PATTERN` (the copied grab-bcv natural-text branch),
  `ROUTE_BIBLE_BASE`, and `resolveBibleRef(token): { url } | null` (`tryParsePassage` +
  `toResolverUrl`).
- **`src/plugins/route-bible/index.tsx`** — the plugin: Seam A token (render = chip when
  `resolveBibleRef` succeeds, else plain text) + Seam B interaction (open on click).
- **`src/plugins/index.ts`** — one line: `route-bible` added to the `plugins` array.
- **`package.json`** — `grab-bcv` dependency (browser-safe, no React import, so the Vite
  dep-optimize gotcha in AGENTS.md doesn't apply).
- **`e2e/route-bible.spec.ts`** — chip renders for a valid reference, plain text for a
  non-reference, click opens the resolver URL.
- **`AGENTS.md`** — the plugin inventory facts + a "Scripture references" section (route-bible = Seam A + B). **`CONTEXT.md`** — *Scripture reference* / *Reference chip* glossary terms.
