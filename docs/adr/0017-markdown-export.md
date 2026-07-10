# Markdown export

**What.** A **"Copy as Markdown"** action in the header More menu (`header-more-menu.tsx`)
serializes the current zoom root **and its full subtree** to a nested markdown bullet list and
writes it to the clipboard (`text/plain`), with a success toast. At the top level (no zoom,
`rootId === null`) it exports the whole outline. The serializer is a **pure function**
(`outlineToMarkdown(index, rootIds)`, `src/data/markdown.ts`), unit-tested per the repo's
pure-logic rule, and is the shared core a future selection-copy (Cmd+C on a node selection,
[ADR 0018](./0018-node-multi-selection.md)) reuses unchanged.

**The lucky break: `node.text` is already markdown.** Links are stored `[label](url)`, tags as
`#tag`, inline code keeps its backticks — the folded/chip _display_ is derived at render time, but
the stored source is plain markdown. So the serializer never transforms text or re-renders a token;
it emits `node.text` verbatim and only adds the bullet prefix + indentation.

**The format, and the non-obvious calls it bakes in:**

- **Uniform bullets, never headings.** Root and descendants all serialize identically: `- text`,
  tasks as `- [ ] ` / `- [x] `, 2 spaces of indent per depth level, the export root(s) included as
  the top bullets, an empty node as a bare `- `. _(Amended with ADR 0045: a **paragraph** node
  serializes as its text with no `- ` prefix — markdown's own paragraph syntax — guarded and
  round-tripped per ADR 0044's amendment. "Never headings" stands.)_ _Why not promote the root to an `#` heading?_ It
  would be lossy (a task root `- [ ] Ship it` can't be a heading) and non-uniform (depth would
  change a node's syntax). Bullets match the outline's actual shape and round-trip.
- **Full fidelity — nothing dropped.** The whole subtree is emitted regardless of `collapsed`,
  `completed`/`showCompleted`, or an active tag filter. _Why ignore the view?_ Export captures
  **content**, not the transient view; silently omitting nodes by view state loses data the user
  can't see was omitted. "Export what I see" is a later opt-in (a checkbox), not the default.
- **Anchor = the zoom root** (`getViewRootId()`), read at click time — the header is contextual to
  the current zoom view. At home it's every top-level node.
- **Mirrors resolve to their content.** A mirror row owns no text or children (`mirrorOf` points at
  the source), so the serializer emits the **source's** text and subtree (`contentId = mirrorOf ?? id`,
  with a visited-set guard against a mirror inside its own source's subtree). Markdown can't carry
  mirror-ness, so a mirror exports as a copy — [ADR 0044](./0044-markdown-paste.md)'s round-trip
  exception 3. (Amended with ADR 0044; before this the exporter read the mirror row raw and emitted
  an empty bullet, silently dropping the windowed content.)

**Don't:** switch the root to a heading; make it respect `showCompleted`/filters by default;
re-render tokens or reconstruct display HTML (emit raw `node.text`); reach for a bespoke stored
export format (it's clipboard text). Keep the serializer pure and view-agnostic — its only inputs
are the `TreeIndex` and the root ids.
