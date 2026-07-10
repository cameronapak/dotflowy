# Markdown paste: the inverse of the exporter, not an importer

Status: accepted (2026-07-09)

Pasting multi-line markdown into a bullet builds a **tree of nodes**, not one mashed line. Today `paste.ts` does `plain.replace(/\r?\n/g, " ")` — so **Copy as Markdown** ([ADR 0017](./0017-markdown-export.md)) and **Cmd+C on a node selection** ([ADR 0018](./0018-node-multi-selection.md)) emit a nested bullet list that dotflowy itself cannot read back. This is a broken round-trip we shipped, not a missing import feature. Prompted by [#97](https://github.com/cameronapak/dotflowy/issues/97) (Dylan Shade) and Workflowy's ["proper markdown pasting"](https://blog.workflowy.com/proper-markdown-pasting/).

## The anchor: round-trip, not import

The design is anchored on `parse(outlineToMarkdown(t)) === t`, not on "paste anything from Obsidian and it looks right."

_Why._ The round-trip gives a **hard oracle** — a property test over generated trees — where "looks right" gives only preferences. It makes the grammar decidable: the alphabet is what `markdown.ts` emits, then widened deliberately. And copy/paste _within_ dotflowy is the highest-frequency use of this path and the one currently broken; pasting from Obsidian is the long tail. Workflowy shipped the import-first framing, and its published limitations (H3–H5 unsupported, multi-paragraph blockquotes break, link text unsearchable) are exactly the symptoms of a grammar with no oracle.

**Most of "markdown pasting" is already done.** `node.text` _is_ markdown — `**bold**`, `*italic*`, `` `code` ``, `[label](url)`, `==highlight==`, `||spoiler||`, `#tags` all land verbatim and render. That is ADR 0017's lucky break, running inbound. This feature is **block-level only**.

## Honest by construction — because a paste has no dialog

OPML import ([ADR 0037](./0037-opml-import-export.md)) meets a "degraded, never silent" bar by **counting degradations and disclosing them in a confirm step**. A paste is a keystroke; it has no confirm step and never will. So it cannot borrow that bar. Instead:

> **Never drop a character of content. Freely drop syntax dotflowy cannot represent — but only when the result is idempotent.**

Idempotent: parse it, serialize it with `outlineToMarkdown`, parse again, and you are at a fixed point. The first paste collapses syntax into content or structure; every paste after that changes nothing. Same call ADR 0037 made for `_note` ("note-ness is lost on first import, by design").

## Where it lives: a core pre-pass, not a plugin

`src/data/markdown-import.ts` — pure, dependency-free, `bun test`-able, mirroring `opml-import.ts`'s shape (source → forest → `ChangeOp[]`). `paste.ts` calls it **before** the Seam I chain. Sibling of the exporter it inverts.

- **Not a new Seam I method.** `InputSpec.onPaste` is typed `(input: PasteInput) => string | null` — a single-bullet contract by construction. Widening it to return a forest hands every plugin the structural write path in order to satisfy exactly one caller that is already core. Structural paste _creates nodes_, and every guard that makes node creation safe is core: `runStructural`'s atomic batch and echo-hold (ADR 0009), the history `capture`, `guardProtected` (ADR 0015), the mirror resolve. ADR 0031's keystone is that node-touching code is trusted and compiled in.
- **Not a `markdown` plugin.** The inverse function, `outlineToMarkdown`, is core (`src/data/markdown.ts`). Split parse into a plugin and serialize into core and they will drift — the exact failure ADR 0037's shared core was built to prevent.
- **Not remark/micromark/marked.** A CommonMark library yields an AST of paragraphs and inline nodes, which we would then have to **re-serialize back to markdown** to obtain `node.text` — parse-then-unparse, landing where the raw string already was, having lost byte-exactness on the way. We need block structure and nothing else: measure indent, match a marker, recurse. Do not add a markdown dependency here.

**Consequence, accepted:** because the plugin chain never sees a structural paste, a bare URL inside a pasted line stays **plain text**, while a lone pasted URL still becomes `[url](url)` + chip + unfurl (ADR 0016). Asymmetric, and defensible: pasting a lone URL is an authoring gesture with obvious intent; pasting a document is a transfer, and transfers preserve. ADR 0037 already set this law — "imported plain text behaves exactly as if typed in dotflowy." Typing a bare URL doesn't linkify either. Rejected: autolinking per line (a content transformation the source never asked for, and N unfurl fetches on one paste).

## The trigger

- **Single-line paste is untouched.** No `\n` → today's exact path (Seam I chain, URL wrap, unfurl). Non-negotiable: it is the authoring gesture, and it preserves the links plugin.
- **Multi-line paste is _always_ structural.** No content sniffing.

_Why always._ The current fallback — joining with spaces — **is itself lossy**: the line breaks are destroyed and unrecoverable. There is no "safe" multi-line paste today; the conservative-looking branch is the destructive one. Splitting a joined paragraph back apart is retyping; merging two bullets is one Backspace. That inverts the usual risk calculus. A sniffing heuristic ("fire only if enough lines carry markers") also has a cliff users cannot predict, and a threshold with no principled value.

- **`Mod+Shift+V` = paste literal**: **no transformation of any kind.** Multi-line: lines become bullets one-per-line — no marker stripping, no depth inference. Single-line: the text splices at the caret with the Seam I chain skipped — no URL wrap, no unfurl, no autoformat. One promise with no line-count cliff; it is the exact answer to pasting a diff (`- old` / `+ new` are both CommonMark bullet markers) and the only way to paste a URL as plain text. The key is unbound today. Rejected: scoping the modifier to marker-stripping only — a "literal" paste that still chips your URL is a broken promise, and a modifier whose meaning depends on the line count is a cliff.

## The grammar

| Construct                                 | Maps to                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `-` `*` `+` markers                       | stripped                                                            |
| `1.` `1)` markers                         | stripped (ordinal is positional, recovered from sibling order)      |
| Indentation (tab / 2sp / 4sp)             | depth; skipped depths clamped                                       |
| `[ ]` `[x]`                               | `isTask` / `completed`                                              |
| `-`, `- `, `*` with no content            | an **empty node**, never a dropped line                             |
| Inline markdown                           | **untouched** — `node.text` is markdown                             |
| Blockquote `> x`                          | `>` stripped → `x` (loses quote-ness, keeps every char, idempotent) |
| Heading `#`–`######` + **space**          | a node, level drives nesting                                        |
| Fenced code ` ``` `                       | grammar suppressor                                                  |
| Tables, HRs, frontmatter, setext headings | **not recognized** — literal text                                   |
| Blank lines                               | dropped (separators, not content)                                   |

Four rules the obvious implementation gets wrong:

1. **Heading detection MUST require the space.** `#urgent` is a tag; `# urgent` is a heading. `TAG_PATTERN` is `(?<=^|\s)#[\p{L}\p{N}_-]+` — `#` immediately followed by a word char — and CommonMark requires `#{1,6}` + space. The two are **exactly disjoint, by luck**. "Trim the leading `#`s" silently eats the tags feature.
2. **Strip exactly one marker, never recurse.** A node whose text is literally `- foo` exports as `- - foo`; one strip yields `- foo`, correct. Recurse and the content is gone. Likewise `- # foo` → text `# foo` (the heading grammar only fires at the start of a line's content, before any marker, once).
3. **Marker stripping consumes exactly ONE space, not all whitespace** (`-   item` → `  item`) — the deliberate divergence from every real markdown tool, argued in _One space, not `\s+`_ below.
4. **Empty-bullet handling is load-bearing.** `outlineToMarkdown` emits a bare `- ` (trailing space) for an empty node, which editors and `.trim()` eat. `-`, `- `, `*` must all yield an empty node. Dylan's example input ends with a bare `-`, which is how he found it.

### Headings drive nesting

`## Background` becomes a **child** of the preceding `# Intro`; body and lists under a heading nest beneath it. All six levels, no cliff.

A markdown document's heading hierarchy _is_ an outline — the same tree in a different notation. The `#` characters are dropped, but what they carried (_this contains that_) survives **in the structure**. Flattening headings to sibling bullets genuinely destroys that containment, and it is the exact information the user came to an outliner for.

Two systems compete for depth. The rule: **heading depth sets a floor; list indentation nests inside that floor.** A document whose shallowest heading is `###` (people paste sections, not whole docs) is **normalized** so `###` is depth 0.

### The line is the unit — a deliberate divergence from CommonMark

CommonMark joins consecutive non-blank lines into one paragraph. We do not. **One line, one bullet.** Lazy continuation lines under a list item become child bullets, not appended text.

Honoring paragraph continuation reads nicely on hard-wrapped prose and then fuses a pasted poem, name list, or stack trace into a single bullet — the same failure as the `\n → " "` join, merely rarer. The outliner's atomic unit is the line; markdown's is the paragraph; where they disagree, the outliner wins. **This is the load-bearing divergence, and the thing a future contributor will "fix" by reaching for `remark`.**

### Fences suppress the grammar; they do not become code blocks

A code block cannot exist in dotflowy — `node.text` is one line, and leading whitespace is content in code. Every mapping is a lie, so we do not map. ` ``` ` toggles **raw mode**: lines inside become bullets one-per-line with **no marker stripping and no depth inference**, leading whitespace preserved (`.node-text` is `white-space: pre-wrap`). **The ` ``` ` delimiter lines are kept as bullets.**

Keeping the delimiters is the honest move: nothing is dropped, the user can see and delete them, and a future code-block feature can re-fold them. On re-paste the delimiter bullet serializes as `- ```ts`, which no longer starts with a backtick after the indent, so the fence never re-fires — one pass, then a fixed point.

## Where the tree lands

**A paste behaves exactly as if the user typed the markdown by hand** — Enter at each newline, Tab/Shift+Tab to reach each depth. That is the _specification_; the _implementation_ is one planned `runStructural` batch and never replays keystrokes. It is total, inherits every existing rule, and is the sentence an edge case can be checked against without asking us. (ADR 0037's "behaves exactly as if typed", generalized to structure.)

Falling out of it:

1. A non-empty selection is deleted in source space, collapsing to a caret.
2. `head` = text before the caret, `tail` = text after.
3. The current node absorbs the first pasted line: `head + firstLine`. It inherits `isTask`/`completed` from that line **only if `head` is empty** — otherwise a paste mid-sentence would flip a bullet into a task.
4. **The current node is the depth anchor.** A pasted node at pasted-depth _d_ lands at anchor-depth _d_: pasted children of line 1 become children of the current node (before its existing children); a second pasted root becomes its next sibling.
5. **`tail` appends to the last inserted node's text**, and the caret lands at that seam.

Rule 5 is the surprising one: paste a 40-line document mid-sentence and the rest of the sentence welds onto a bullet four levels down. That _is_ what typing does, and every alternative ("tail stays put", "tail becomes a sibling") invents a special case the spec does not sanction. It almost never fires — real pastes land at end-of-line or in an empty bullet.

**The one exception: the zoomed title.** Its siblings live outside the view, so inserting one makes it vanish. When the target is the title, remaining roots become **children of the title**, prepended before its existing children. This is the two-render-paths trap: a row-only implementation ships broken here.

**Two guards, not optional.** Mirrors resolve `mirrorOf` **before** planning, or a paste into a mirror creates children on the wrong node (ADR 0022; `link-edit-popover.tsx` does the same resolve). The plan goes through `guardProtected` like every other command funnel (ADR 0015) — pasting a forest _under_ the Daily container is fine; blanking its canonical text is not.

**View transforms can hide what just landed; the paste must not fight them.** Filtering is render-time only and stays untouched: pasted `- [x] done` lines under hide-completed, or non-matching lines under an active tag filter (`?q=`), arrive hidden — exactly what as-if-typed prescribes (completing a bullet under hide-completed hides it today). Two rules fall out. **Focus falls back**: the seam node may be hidden, so focus walks backward through the inserted nodes to the last visible one, else the anchor node. **The all-hidden paste gets a toast** ("Pasted N bullets — hidden by the current filter"): a paste that changes nothing on screen is the one silent outcome, and loud is the only disclosure a paste has. Rejected: clearing the filter or flipping show-completed as a side effect — a paste never mutates view state.

## Execution — reuse, not invention

- **One `capture()` + one `runStructural` batch** → one Cmd+Z removes the whole paste (ADR 0009).
- **Under `RESTORE_SLICE_OPS` (500): synchronous `runStructural`.** This is the keystroke-adjacent path and must never regress. At or above: `runStructuralSliced` behind a progress modal, the `HistoryRestoreDialog` pattern.
- **No confirm step.** `DELETE_CONFIRM_THRESHOLD` exists because deletion is destructive; paste is additive and one Cmd+Z away. A confirm on Cmd+V would be intolerable.
- **Hard ceiling `OPML_APP_MAX_NODES` (50,000)** plus a raw-length guard before parsing (`DEFAULT_MAX_OPML_LENGTH`'s shape). One number, one place. Over ceiling → **rejected with a toast**, nothing inserted. Rejection is loud, which is the only disclosure surface a paste has.
- **No wrapper container** (OPML wraps because a migration lands in an unknown place; a paste lands at your caret) and **not collapsed** (OPML's `collapsed: true` was a 17k-node perf guard; pasted content is meant to be seen).
- **Focus lands at the seam** in the last inserted node; the virtualized path needs `scrollRowIntoView(id)` (`virtual-nav.ts`), since that row may not be mounted. **No `.node-acted` flash** — new bullets under your caret are self-evident.

## The invariant, and its three exceptions

> `parse(outlineToMarkdown(t)) === t` for all trees `t`, except:
>
> 1. **Bible references.** `outlineToMarkdown` calls `bibleRefsToMarkdownLinks`, so `Romans 5:3` exports as `[Romans 5:3](https://route.bible/…)` and pastes back as a **link**, not a chip. Content is byte-preserved, presentation shifts once, the result is stable. Rejected: stripping route.bible links on import (fragile magic that mangles a hand-authored link) and dropping the projection from export (it exists so exported markdown works in Bear — ADR 0017's portability intent).
> 2. **Task markers as literal text.** A non-task node whose text is `[ ] buy milk` exports as `- [ ] buy milk` and re-imports as a task. dotflowy has **no escape syntax** and inventing one fights the parsed-from-text model (ADR 0037 settled this). The todos `[]` autoformat makes that text nearly unreachable by typing.
> 3. **Mirrors flatten to copies.** Markdown cannot carry mirror-ness, and dropping the _content_ is not an option — so `outlineToMarkdown` resolves `contentId = mirrorOf ?? id` and emits the **source's** text and subtree (with a visited-set guard: a mirror inside its own source's subtree emits its text once and does not descend). A copied mirror therefore pastes back as an **independent copy**; the relationship collapses on the first pass and is a fixed point after. Rejected: exporting `[[sourceId]]` (a link points, a mirror windows — the glossary keeps them distinct, and a raw id is garbage in any other app) and inventing a mirror escape syntax (ADR 0037 settled that). This also **fixes a shipped hole**: the exporter currently reads the mirror row raw and emits an empty childless bullet, silently dropping the windowed content from every copy — the mirrors flag broke ADR 0017's "nothing dropped" and nobody noticed.
>
> All three are stable under further round-trips.

### One space, not `\s+`

There is no fourth exception. There nearly was.

`outlineToMarkdown` emits `- ` + text, so a node whose text is `  const x` serializes to `-   const x`. Consume `\s+` after the marker — the rule every lenient markdown reader follows — and those two spaces are gone on re-import. It reaches a fixed point after one pass, so it hides well. It also **drops characters**, which the fidelity bar forbids outright.

This is not the corner it looks like. Paste a Python block, copy the outline as markdown, paste it back: **every level of indentation is gone.** That is the round-trip this ADR is named for, run against the fence rule three sections up, which promises to preserve exactly that whitespace. The promise held for exactly one paste.

So `LIST_MARKER_RE` and `TASK_RE` consume **exactly one** space or tab — the one the exporter wrote. Everything after it is content.

The parser has two jobs that collide on this character: be `outlineToMarkdown`'s inverse, and be a lenient importer of other people's markdown. This ADR already said which wins — _the inverse of our own export, not "import anything"_. The cost is paid there: foreign markdown that pads its marker (`-   item`, or `1.  item` aligned against `10.`) imports with the padding as leading text, visible under `pre-wrap`.

That trade is decided by which harm is recoverable. A kept leading space is on screen and one keystroke from gone. Dropped indentation is silent, and the characters are not in the store to get back.

Rejected: **stop preserving fence indentation** (breaks the fence rule, and code without indentation is not code); **an escape syntax for leading whitespace** (ADR 0037 settled that dotflowy has none); **accept and document it** (a documented character-dropping gap is not an invariant, it is a footnote pretending to be one).

Property-test the identity over generated trees with the three exceptions carved out — the corpus carries leading-whitespace texts, so a regression here fails the property test, not just a named case — and generate trees **with** mirrors, asserting the round-trip equals the mirror-resolved flattening. Everything else round-trips clean: emphasis, links, highlights, spoilers (raw `||x||` per ADR 0043), inline code, `#tags`, date tokens, node links.

## Markdown is the interchange format for node state, never its storage

Considered and **rejected**: storing task-ness as a `[ ] ` prefix in `node.text` and dropping the `isTask`/`completed` fields.

The line this repo already draws — and it is principled, not accidental — is: **inline constructs live in text; node state lives in fields.** The test is _does it change when the text doesn't?_ You check a box; the sentence you wrote does not change. `src/plugins/todos/index.tsx` already records the call: "the `completed`/`isTask` FIELDS stay node slots for hot-path speed."

Moving it would: hit the hot path ADRs 0004 and 0019 protect (`buildVisibleRows` filters `completed` on every `structureRev` bump — a boolean read becomes a regex over every node's text); collide with ADR 0010 (a checkbox toggle becomes a text edit racing the typing coalescer); touch ~40 files, `wire-schema.ts` across both tsconfigs, the DO's SQLite columns, `worker/mcp-tools.ts`, and OPML's `_complete`/`_task`; and degrade agents, who currently receive structured `isTask`. It would make exception (2) above _definitionally_ impossible — genuinely — at the cost of a **permanent expressive hole**: the sentence `[ ] buy milk` could never be plain text in any bullet. A rare boundary bug traded for an inescapable one.

Todos already speak markdown at every boundary a user or agent can touch (paste, Copy as Markdown, Cmd+C, OPML, MCP, the `[]` autoformat). The one gap this change closes: **widen the todos autoformat to accept a typed `[ ] ` and `[x] `, not just `[]`.**

## Out of scope

The `text/html` lane (Notion, Google Docs, a webpage — needs a sanitizer and an HTML→markdown converter; v1 reads `text/plain` only, where markdown-native apps put their markdown); an `import_markdown` MCP tool (`add_subtree` covers agent writes with a real schema, and ADR 0037 settled that file migration is the app UI's job); drag-dropping a `.md` file; **paste while nodes are multi-selected** (ADR 0018) — selection mode has no caret and printable keys already no-op, so v1 no-ops. Copy works there and paste will not; inventing a third landing rule at the end of a design session is how you get a rule you regret.

Also out, each a written decision rather than an omission:

- **A touch literal paste.** `Mod+Shift+V` is keyboard-only; coarse pointers get no hatch in v1 and undo is the recourse. When demanded — or if the keydown spike fails (known risks) — the designated shape is a Cmd+K **"Paste as plain lines"** action over `navigator.clipboard.readText()` (user-gesture-gated, no paste event involved), which serves keyboard and touch alike. It is not built until then.
- **A native clipboard flavor** (`application/x-dotflowy` written alongside `text/plain`, preferred on paste — it would make internal copy/paste exact and dissolve the round-trip exceptions for the internal case). Weighed and rejected for v1: the markdown lane must be bulletproof regardless (external paste exists), so a second serializer only adds the drift ADR 0037's shared core exists to prevent; custom-format clipboard support is uneven across browsers (Chromium wants `web `-prefixed formats, Safari lags); and the exceptions it would dissolve are presentation shifts, not data loss. Revisit when sharing lands — a native payload's id semantics across outlines (a pasted `mirrorOf` pointing into someone else's tree) belong to that ADR.

## Known risks, and what measuring them showed

- **~~The `Mod+Shift+V` hatch is unverified.~~ Verified.** The `paste` event exposes `clipboardData`, not modifier keys, so the chord is armed on the preceding capture-phase `keydown` and read by the paste that follows (ProseMirror's shipped technique). Chromium fires `keydown` (`shiftKey: true`) _then_ `paste` for the `pasteAndMatchStyle` editing command it maps that chord to — confirmed against the real clipboard and pinned by `e2e/markdown-paste.spec.ts`. The Cmd+K "Paste as plain lines" fallback is therefore **not built**; it remains the designated shape if touch demand appears. _Testing gotcha:_ Playwright's `keyboard.press("Meta+Shift+V")` attaches no editing command, so the keydown lands and no paste is ever generated. The spec drives the raw CDP `Input.dispatchKeyEvent` with `commands: ["pasteAndMatchStyle"]` instead.
- **~~A 5,000-node expanded paste's `buildVisibleRows` cost is unmeasured.~~ Measured; not a problem.** A 400-line paste (the synchronous path) occupies the paste handler for ~45 ms. A 5,000-line paste crosses `RESTORE_SLICE_OPS` into the sliced path, so the handler returns in ~12 ms and the whole batch settles in ~3.7 s behind the modal progress. No collapsed-container guard is needed, and none is added — pasted content is meant to be seen.
