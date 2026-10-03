---
status: accepted
---

# Session-local undo and redo

Dotflowy's existing undo restores whole-outline snapshots, which can overwrite
changes from another tab, device, or agent. Keep one core-owned history for
outline authoring, but clear it when a genuine external outline edit arrives.
This trades uninterrupted undo across devices for a smaller first pass that
does not undo someone else's changes.

## Decisions agreed during design

- **Keep history local to the tab and session.** Zoom and navigation preserve
  history; reload clears it. Other tabs have their own history. Persistent and
  cross-device history are outside this change.
- **Undo authoring, not browsing.** Include text, formatting, kind, completed
  status, creation, deletion, moves, paste, and imports. Exclude navigation,
  filters, collapse/expand, theme, text size, and plugin side-data such as tag
  colors. Replay must not rewind excluded state as a side effect.
- **Clear undo and redo on external edits.** Distinguish genuine external
  changes from this tab's own sync echoes. Explain the reset with a brief notice.
  Do not record external edits as local undo steps or replay stale history over
  newer external changes. Selective undo across concurrent changes is deferred.
- **Make text undo feel familiar.** Use normal text undo as the behavioral
  reference for typing and deletion runs, paste, selection replacement, and
  caret restoration. Composition stays together. Text and structural actions
  share one ordered history; a fresh edit clears redo. Exact browser-specific
  grouping and a particular pause threshold are not design requirements.
- **Keep quick-add on the shared history.** While quick-add is open, undo and
  redo stay within the current thought. An empty draft, or one with no more
  undoable changes, must not reach older outline actions or previous captures
  from Cmd+Enter. After capture closes, one undo removes the captured node as a
  whole rather than walking through its drafting. Later moves and edits remain
  separate actions. Prefer a simple implementation over a separate undo system.
- **Return to the editing location.** Restore the affected render path and its
  caret or selection, returning to that location if you navigated elsewhere.
  If it is already visible, scroll it into view. Navigation does not become an
  undo step.
- **Preserve filters.** If a filter hides the affected node, keep the filter
  intact and show a brief confirmation with a **View node** action. Do not
  silently clear the filter to reveal the change.
- **Use quiet UI.** Put undo and redo at the top of **More** and in **Cmd+K**,
  with action labels such as **Undo typing**, **Undo move**, and **Redo delete**.
  Keep the existing mobile editing capsule; do not add desktop header arrows.
  Disable unavailable history actions using shared history state.
- **Show feedback when the change is not visible.** Ordinary visible undo and
  redo need no success toast. If a successful restore produces no visible
  change, show a brief toast. Keep progress feedback for large restores and
  explain failures without reporting success.

## Existing boundaries and implementation status

The implementation uses the existing mutation facade, command bridge, and
history restore funnel rather than a new plugin or unified command registry
([ADR 0001](./0001-plugin-architecture.md),
[ADR 0034](./0034-cmd-k-command-center.md)). Cover all three editor render paths:
outline rows, zoomed titles, and quick-add.

Structural replay keeps the atomic-write guarantees of
[ADR 0009](./0009-atomic-structural-writes.md); ordinary typing retains the
direct field-edit path of
[ADR 0010](./0010-field-edits-serialize-coalesce-ignore-echoes.md).
Excluding collapse/expand changes the current capture behavior. Disabling
unavailable history actions replaces the always-enabled history-button policy in
[ADR 0030](./0030-mobile-actions-bar.md). The other mobile buttons and the
capsule's focus-preserving behavior are unchanged.

Replay waits for pending quick-add captures, older writes, and their sync echoes.
Each page marks its writes with a session-local client id. The Durable Object
rejects replay unless its sequence still matches the state used to plan it.
Guarded replay does not retry a lost acknowledgement; an uncertain outcome
clears history and refreshes server truth instead of claiming nothing changed.

Draft consolidation folds contiguous steps. If an independent outline action
interrupts drafting, that action remains a separate undo step in its original
order; consolidation must not rewind it along with the draft.
