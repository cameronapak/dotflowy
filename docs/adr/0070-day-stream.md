---
status: accepted
---

# The day stream replaces the single-day page

A zoomed Daily note now reads as a **Day stream**: one page per calendar day,
continuing into earlier and later days, with free vertical scrolling.
It replaces the single-day page. Cam picked this over a Reflect-style
newest-first stream and a two-column timeline after trying all three as clickable
prototypes. It keeps today's page anatomy and steps through days one at a time.

This amends [ADR 0054](./0054-week-calendar-subheader-strip.md) (the strip now
scrolls the stream and can be turned off) and extends
[ADR 0064](./0064-account-wide-editor-feature-preferences.md) with per-feature
options.

## Decisions

1. **Scope matches the week strip.** The stream shows only when the zoom root
   maps to a day key. Week, month, year, and the Daily container stay ordinary
   outlines. Zooming into a bullet under a day leaves the stream; zooming back out
   returns to it. A day note moved out of the Daily tree still opens the stream.
   An active `?q=` filter falls back to the single-day page, because a filter
   transforms one root. So does turning the **Day stream** option off.

2. **One flat list across days, in core.** The editor's virtualized flat list
   ([ADR 0019](./0019-virtualized-outline-rendering.md)) grows from one root to an
   ordered sequence of roots. Each day contributes a title row and its visible
   rows. Arrow keys cross day boundaries through one small bridge, and commands
   act on the day you are working in. The Daily plugin supplies the day sequence through a new seam,
   so core never learns what a day is (ADR 0001). Rejected: one `OutlineEditor`
   per day. That stacks N virtualizers and splits focus, selection, and drag at
   every day boundary.

3. **An Empty day is a placeholder, not a node.** Scrolling and
   clicking a strip pill create nothing. The first keystroke on an Empty day
   creates the day, its scaffold, and the typed entry through the existing
   get-or-create, then hands the caret to the new row. Focus without typing leaves
   nothing behind. Placeholders follow the daily-index, so a day created elsewhere
   fills in live. This keeps [ADR 0041](./0041-daily-note-entry-point-seeding.md)'s
   "entry point, not invariant" rule. Day creation stays out of undo, as it does
   elsewhere. The typed text stays in undo.

4. **The URL follows the day in view through a search param, not navigation.**
   `rootId` stays route-owned and becomes the stream's anchor: the day you opened.
   Once scrolling settles (debounced, about 300 ms), the stream writes the day in
   view to `?day=YYYY-MM-DD` with a replace, so the browser history gains no
   entries. Only the search param changes, so `rootId` and the zoom, focus, and
   morph effects keyed on it stay untouched, and the caret stays where it is while
   you edit. The param is dropped when the day in view is the anchor. On load, the
   stream anchors on `rootId` and then scrolls to `?day`, once the daily index
   has loaded. The URL keeps `?day` until that day is in view or you scroll. A
   day key works for Empty days, which have no node id. `validateOutlineSearch` allows `day` and drops a
   malformed value. Rejected: rewriting `/$nodeId` on scroll, which refires the
   zoom effects and cannot address an Empty day. Rejected: a bare
   `history.replaceState` outside the router, which leaves the router's location
   stale.

5. **Both directions, loaded lazily.** The stream extends into the past and the
   future, so it also works for planning ahead. Days load in windows at either
   edge. Prepending keeps the day in view fixed on screen. The stream reaches 30
   days before and 60 days after the outermost day with a note, today, and the
   anchor. A calendar pick past that reach navigates to the day instead, which
   anchors a new stream there.

6. **Vertical scrolling stays where you leave it.** Each day is at least one
   viewport tall minus a peek of the next day's title. Automatic proximity
   snapping was removed because a pending scroll gesture could snap after a
   node drop, moving the reading position and potentially changing the day in
   view even when the drop target was already visible. Settling resumes deferred
   day loading but does not align a day title. Explicit navigation still aligns
   the destination title. No new keyboard shortcut: arrow keys already cross
   days, and the strip and Today button jump.

7. **Entry points are unchanged.** The Today button, `/today`, and Cmd+K "Go to
   Today" open the stream anchored on today and seed one entry line, as before.
   Date chips and other reference paths anchor the stream without seeding.

## Daily notes options

Daily notes gains three options in Settings, Editor features, shown under its
switch and disabled while it is off:

- **Day stream**: on (default) or off. Off restores the single-day page.
- **Empty days**: _Show every day_ (default), _Fold empty days_, or _Skip empty
  days_. Folding collapses each run of consecutive Empty days into one line, such
  as "Oct 15 - Oct 18, 4 empty days", and clicking it expands the run. Folding and
  skipping never apply to today or the anchor day. Disabled while the Day stream
  is off.
- **Week strip**: on (default) or off. With the strip on, the selected pill
  follows the day in view and a click scrolls the stream there. Dragging nodes
  onto a pill still moves them to that day (ADR 0054 decision 8). Independent of
  the Day stream option: with the stream off, the strip keeps its ADR 0054
  behavior.

Options are account-wide, like the feature switch and Week start
([ADR 0068](./0068-account-wide-semantic-week-start.md)). They are stored as
separate `account-prefs` rows (`daily:day-stream`, `daily:week-strip`,
`daily:empty-days`), beside `daily:week-start`, and a missing row means the
default. Rejected: device-local storage, which would make
the same account read differently on each device.

## Known limits

- The arrow-key caret walk crosses into a day's title and rows, but skips an
  Empty day's placeholder line. Click or use the strip to write there.
- A bullet drag drops within the day it started in. To move a bullet to
  another day, drop it on that day's strip pill or use `/move`.
- Multi-selection stays within one day.

## Out of scope

- **A month calendar in a right sidebar.** It is wanted, but needs its own
  right-sidebar seam and a narrow-screen drawer
  ([ADR 0066](./0066-narrow-screen-menu-drawers.md)). Design it as a follow-up.
  The Week strip option can later grow into a choice of day navigator.
