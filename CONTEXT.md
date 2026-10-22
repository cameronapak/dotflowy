# dotflowy

The ubiquitous language for dotflowy's outline domain. A glossary, not a spec — definitions only, no implementation. Decisions and their trade-offs live in [`docs/adr/`](./docs/adr/).

## Language

**Node**:
A single item in the outline. Owns its text and, via child pointers, its subtree. Every node has exactly one Kind; "bullet" names one kind of node, not the node itself.
_Avoid_: item, bullet (when precision matters), block

**Locked**:
An owner-controlled state that prevents changes to a node's content and its full descendant subtree until the owner unlocks it in the editor. A locked subtree may still move intact.
_Avoid_: read-only, frozen, protected

**Kind**:
Which of the mutually exclusive presentations a node has: bullet, task, paragraph, or Embed. Exactly one — converting between kinds is allowed, combining is not. Independent of Completed.
_Avoid_: type, mode, style

**Paragraph**:
A node that reads as prose rather than a list item — a paragraph glyph (an align-left mark) stands where a bullet shows its dot, carrying the same zoom and drag affordance. Full tree citizen: children, collapse, zoom, complete.
_Avoid_: text node, block, prose node

**Embed**:
A node devoted to displaying one external resource identified by a URL. The external content is read-only and is not part of the outline's text; the node can have child notes, move, collapse, zoom, and be mirrored like other nodes.
_Avoid_: oEmbed (the protocol, not the node), preview (also describes ordinary link metadata)

**Completed**:
Done-status on any node, regardless of kind: "I'm done with it, mentally archiving it, but it still exists." Not deletion, and not task-only — a checkbox is a Kind; done-ness is state.
_Avoid_: done, checked, archived

**Mirror**:
A node that, instead of owning its own text and children, windows another node's. Editing a mirror edits the underlying content, so every place it appears updates. Has its own location and view state, but not its own content.
_Avoid_: copy, clone, alias, synced block, transclusion

**Source**:
The node a mirror points at — the one that actually owns the text and children. Every mirror has exactly one source; a node with no `mirrorOf` is its own source. Not to be confused with Text source, a different thing the code also calls "source".
_Avoid_: original, master, target

**Text source**:
A node's text as the author wrote it: raw markdown. What the editor renders is derived from it — a link folds to a chip, `**bold**` to a styled run — but the text source is what is stored, copied, exported, and parsed. Distinct from Source (the mirror target); the code says "source" for both, and `readSource` means this one.
_Avoid_: raw text, markup, content

**Instance**:
Any one rendering of a node's content at a location. The source is an instance; each mirror is an instance. Instances are equal for editing — there is no read-only one.
_Avoid_: occurrence, appearance

**Link**:
An inline reference to another node, stored in the referring node's text. A link is a pointer you travel through — click it and you go to the target — never a window into the target's content. Contrast with Mirror, which makes content live in two places; a link only points.
_Avoid_: wiki-link, mention, internal link

**Backlink**:
The reverse view of a link: from a node, the set of nodes whose text links to it. Derived from links, never stored on the target.
_Avoid_: reference (too generic), citation

**Render path**:
The chain of node ids from the current view root down to a rendered row. A row's identity (its key, its focus/caret/drag address) — distinct from the node id, because the same node can render at more than one path once mirrors exist.
_Avoid_: trail (that's the ancestor breadcrumb, a different walk)

**Structural paste**:
A paste that lands as nodes rather than as text — the pasted markdown's block structure becomes real bullets with real nesting. Contrast with an ordinary paste, which splices text into one node at the caret. Multi-line is structural; single-line never is.
_Avoid_: smart paste, markdown paste (that names the input, not what happens)

**Literal paste**:
A paste told to transform nothing. Multi-line still lands as nodes — one line, one bullet — but no grammar runs: markers stay, depth is not inferred. Single-line splices in as plain text with no plugin rewriting. An escape from interpretation, not from structure.
_Avoid_: plain-text paste (names the clipboard lane, not the behavior), paste without formatting

**Spoiler**:
A run of a node's text the author marks as sensitive — `||hidden||` in the source. To a human (in the editor, in a copy, in an export) it is merely _hidden until revealed_: shown as an opaque bar until the caret enters it. To an AI agent over MCP it is **redacted** — the interior never crosses the boundary; the agent sees `[spoiler]` and cannot search inside it. The same mark, treated differently by audience. Not access control (the agent holds the user's own credentials) — a context-hygiene default that keeps flagged text out of an LLM's window.
_Avoid_: secret, redaction (that's what MCP does to it, not what it is), hidden block

**Filter**:
A query applied to the current view that prunes it to matches and their context. Purely a way of _looking_ at the outline: it changes nothing — not collapse state, not the caret's location, not where you are. Clearing it restores the exact prior view. Contrast with navigation (Cmd+K), which takes you somewhere.
_Avoid_: search (that word implies going to a result; a filter stays put)

**Operator**:
A typed term in a filter query that tests something other than the node's text — `is:todo`, `#tag`, `highlight:red`, `-is:complete`. Each operator's meaning belongs to the feature that owns the thing it tests.
_Avoid_: keyword, flag, modifier

**DQL (Dotflowy Query Language)**:
The query language for selecting nodes by text, tags, and operators. A query describes the conditions a node must satisfy, not how its matches are presented.

**Match**:
A node the active filter selects. A match shows undimmed with its subtree reachable as normal; its ancestors render dimmed, as context that says where the match lives rather than as results themselves.
_Avoid_: result, hit

**Saved query**:
A filter query kept for reuse, with a name. Saves the question, not the place — running it filters whatever view you're in. The pin's twin is the Bookmark: a bookmark pins a place, a saved query pins a question.
_Avoid_: saved search (a filter stays put; see Filter), smart view

**Daily note**:
The node identified with one local calendar day. It owns that day's captured and organized nodes as its children; the Daily note is the dated parent, not each entry beneath it.
_Avoid_: day page, journal entry (that names a child, not the dated parent)

**Day stream**:
How a zoomed Daily note reads: one page per calendar day, continuing into the days before and after it, so scrolling steps through days in order. Shown only for day notes, never for weeks, months, years, or the Daily container.
_Avoid_: day view, journal, feed, timeline

**Empty day**:
A calendar day with nothing written in it, whether or not its Daily note exists yet. Showing an Empty day never creates its Daily note; writing in it does.
_Avoid_: blank day, missing day, unminted day (implementation detail)

**Calendar week**:
A seven-day period in Daily notes whose first day is the account's Week start. It belongs whole to the month and year containing its fourth day.
_Avoid_: ISO week (only Monday-start Calendar weeks follow ISO boundaries), week row

**Week start**:
The account-wide choice of Sunday or Monday as the first day of every Calendar week.
_Avoid_: first weekday, calendar display order

**Quick-add**:
Capturing a thought as a real node in one uninterrupted gesture, without looking at where it lands. The node commits immediately to the account's default destination and is relocatable afterward; the whole point is to write the thing down before the destination's existing content distracts you out of remembering it. Distinct from navigation (Cmd+K takes you somewhere) and from an ordinary new node (which is authored in place, in view of its siblings).
_Avoid_: quick capture (fine as a synonym, but the action is "quick-add"), inbox (capture is not a holding bucket), compose

**Capture key**:
A revocable credential that permits Quick-add to its owner's daily notes from outside the editor, without permission to read, edit, or delete existing outline content.
_Avoid_: account key (implies broader access), MCP token (a different credential)

**Editor feature**:
An optional reading or authoring convenience, such as Bible references or Daily notes. Turning it off changes the editor experience, not the outline's content or external tools' permissions.
_Avoid_: plugin unloading, access control

**Scribble mode**:
A writing view that displays outline text in a scribble font, including the active node, to reduce distraction and rereading while you write. It changes appearance, not text source, and is distinct from a Spoiler.
_Avoid_: redaction, hidden text, privacy mode

**Focus session**:
A time-boxed commitment to one node that you choose to work on. It stays visible while you work anywhere in the outline, and it ends when you finish, let it go, or end it early. Starting one changes neither the node nor where you are.
_Avoid_: focus mode (Spotlight is the dimming view mode), timer, pomodoro (one way to run a session)

**View menu**:
The header menu for the outline view you are looking at: actions scoped to the current zoom root, and display modes such as Show completed and Spotlight mode.
_Avoid_: More menu, overflow menu, options menu

**App menu**:
The header menu, opened from your avatar, for Dotflowy itself and your account: Settings, What's new, help links, legal pages, and Sign out. Nothing in it changes the outline view.
_Avoid_: More menu, account menu, profile menu
