# dotflowy

The ubiquitous language for dotflowy's outline domain. A glossary, not a spec — definitions only, no implementation. Decisions and their trade-offs live in [`docs/adr/`](./docs/adr/).

## Language

**Node**:
A single item in the outline. Owns its text and, via child pointers, its subtree. Every node has exactly one Kind; "bullet" names one kind of node, not the node itself.
_Avoid_: item, bullet (when precision matters), block

**Kind**:
Which of the mutually exclusive presentations a node has: bullet, task, or paragraph. Exactly one — converting between kinds is allowed, combining is not. Independent of Completed.
_Avoid_: type, mode, style

**Paragraph**:
A node that reads as prose rather than a list item — a paragraph glyph (an align-left mark) stands where a bullet shows its dot, carrying the same zoom and drag affordance. Full tree citizen: children, collapse, zoom, complete.
_Avoid_: text node, block, prose node

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

**Match**:
A node the active filter selects. A match shows undimmed with its subtree reachable as normal; its ancestors render dimmed, as context that says where the match lives rather than as results themselves.
_Avoid_: result, hit

**Saved query**:
A filter query kept for reuse, with a name. Saves the question, not the place — running it filters whatever view you're in. The pin's twin is the Bookmark: a bookmark pins a place, a saved query pins a question.
_Avoid_: saved search (a filter stays put; see Filter), smart view

**Quick-add**:
Capturing a thought as a real node in one uninterrupted gesture, without looking at where it lands. The node commits immediately to a default destination (today's note) and is relocatable afterward; the whole point is to write the thing down before the destination's existing content distracts you out of remembering it. Distinct from navigation (Cmd+K takes you somewhere) and from an ordinary new node (which is authored in place, in view of its siblings).
_Avoid_: quick capture (fine as a synonym, but the action is "quick-add"), inbox (the default is today, not a holding bucket), compose
