# dotflowy

The ubiquitous language for dotflowy's outline domain. A glossary, not a spec — definitions only, no implementation. Decisions and their trade-offs live in [`docs/adr/`](./docs/adr/).

## Language

**Node**:
A single bullet in the outline. Owns its text and, via child pointers, its subtree.
_Avoid_: item, bullet (when precision matters), block

**Mirror**:
A node that, instead of owning its own text and children, windows another node's. Editing a mirror edits the underlying content, so every place it appears updates. Has its own location and view state, but not its own content.
_Avoid_: copy, clone, alias, synced block, transclusion

**Source**:
The node a mirror points at — the one that actually owns the text and children. Every mirror has exactly one source; a node with no `mirrorOf` is its own source.
_Avoid_: original, master, target

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
