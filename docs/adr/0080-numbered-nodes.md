# Numbered nodes: Kind with position-local numbers

Status: accepted; personal portal review and deployment approved.

Numbered is a mutually exclusive node Kind, encoded as `kind: "numbered"` with
`isTask: false`, following ADR 0045. A number replaces the dot inside the same
zoom/drag button. The number is not stored text or an independently editable
field: it is derived from consecutive numbered siblings, restarting at 1 after
any other Kind. Each nesting level has independent runs. A mirror shares its
source's Kind but gets its own position-local number.

The number is right-aligned and its handle grows leftward into the gutter,
leaving the same content column as bullets, paragraphs, and quotes. On desktop
the collapse chevron moves left with that handle so their hit targets do not
overlap. A numbered zoom title keeps the row's content column and gap, with
the existing larger, bold title typography applied to both the number and
the text. The number hangs outside the text so wrapped lines share one edge.
Desktop number targets fit their digit count and line box, without reserving
two-digit width for single-digit items or inheriting the 44px vertical touch
expansion. Coarse pointers retain a minimum 24px width and 44px vertical target.
While a row is focused, other numbered markers fade like the existing markers;
their text stays unchanged. Hovering a number still shows its zoom affordance.

## Why derived numbers

Persisting an ordinal would turn a single move into writes to every following
sibling and create competing numbering edits during sync. DOM counters are also
wrong: the outline is a flat virtualized list (ADR 0019), so filtered and
offscreen siblings are absent. Core derives numbers from complete sibling runs
and caches them per parent, invalidating on membership, order, Kind, and mirror
resolution changes, including source deletion. Text, collapse, completion, and
filter changes do not rebuild numbering. No side-collection or storage migration.

## Editing and quote precedence

Typing exactly `1. ` at source offset 0 of a bullet or paragraph converts it and
consumes the marker in one Kind/text edit and undo step. Only insertion at offset
3 triggers this; deletion, literal paste, IME composition, and markers elsewhere
do not. Existing literal numbered text is not migrated. `/numbered` also converts
the current node or a selection through the ordinary locking/protection guards.
`/bullet`, `/paragraph`, and `/todo` convert out of numbered Kind.

Enter splits or adds a numbered sibling, even when that numbered node has open
children; this deliberately differs from ordinary bullet Enter, which dives
into open children. Enter at the start of nonempty text keeps the existing
make-room-above rule. Enter on an empty numbered row becomes a paragraph in
place. Backspace at source offset 0 reveals the current ordinal plus period as
paragraph text, deleting the implied trailing space as in ADR 0045. Only `1. `
triggers typing conversion; restoring another revealed ordinal stays literal.

A numbered quote keeps its number handle rather than the quote bar. The quote
remains source text with the existing folding and marker rules. Backspace removes
the quote marker first; a later Backspace reveals the numbered marker. Enter on
an empty quote removes its quote marker first; a later Enter exits numbered Kind.
The zoomed title retains the source position's number as a non-interactive mark.
Typing shortcuts stay row-only; titles and Quick-add retain their own keymaps.

## Interchange and compatibility

Markdown ordinal markers import as numbered Kind unless a checkbox makes them
tasks. Export computes actual sibling numbers, including for partial selections;
reimport normalizes starts to 1, because arbitrary starts are not stored. OPML
preserves `_kind="numbered"`. CLI and MCP accept and return the new Kind, and
`is:numbered` is shared by browser and agent search. Hiding completed nodes or
filtering leaves number gaps rather than changing their identity within the run.

Older browser bundles and CLI versions have closed Kind enums. The browser
advertises `numbered: true` in its sync hello and `x-dotflowy-numbered: true` on
node HTTP requests. Socket capability lives in its hibernation attachment, not
an in-memory map. Missing capability means legacy, including sockets accepted
before deployment. Outgoing legacy GET, snapshot, resume and change messages
project numbered Kind to a bullet (`null`) while retaining frame metadata. Rows
and the retained changelog remain canonical. No migration is needed.

Legacy text, completion, collapse and bookmark patches remain usable. Full-node
upserts, structural batches, deletion, and patches naming Kind/task fields that
touch stored numbered nodes fail atomically with HTTP 409
`client_upgrade_required`. Their capability check runs inside the DO write
transaction. Merely preserving Kind is unsafe: old undo snapshots can restore
paragraph/task state or delete and reinsert a projected bullet, losing numbering.
Reject the entire request, including coupled text and sibling repoints, rather
than acknowledging a partial or silently altered intent. Current clients retain
normal conversion, deletion and history behavior. This capability is a format
claim, not an authorization boundary; auth and locking checks are unchanged.

MCP search defaults to legacy bullet-compatible output. `numbered: true` opts
into full Kind values; the new CLI supplies it on every page. Matching uses
canonical nodes before output projection, so `is:numbered` still works. The
response mode participates in the cursor fingerprint. Existing CLI versions
can keep reading without needing a coordinated npm release.

The server-version toast can now decode its handshake and offer reload without
forcing one or losing pending text. Reload/update is required for full numbered
editing, not for safe basic access. Custom starts, restart controls, letter/Roman
numbering, and numbered tasks remain outside this version.
