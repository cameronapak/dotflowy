---
status: accepted
---

# Focus sessions

A **Focus session** is a time-boxed commitment to one node. Its purpose is
intention: you choose what to work on, keep that choice in view while you work
anywhere, and close it honestly. It ships as a reviewed, compiled-in plugin
(ADR 0001, ADR 0031). Spotlight (ADR 0033) remains the only dimming mode;
a session never dims the outline.

## Product contract

- **Start.** `/focus` and Cmd+K start a session on the node that holds the
  caret. "Focus on this page…" in the View menu starts one on the current zoom
  root and is hidden at Home. The picker offers 15, 25, 45, or 60 minutes,
  Pomodoro, or a custom length, and remembers the last choice. Starting does not
  move you or change the node.
- **One at a time.** Starting a new session while one runs shows
  "Replaces: …" in the picker. The old session ends as Let go with no
  reflection prompt. While a session runs, the View menu also offers
  "End focus session".
- **Visible everywhere.** The session renders as a depleting band in the
  subheader and as a draining pie marker in the `after-text` slot of the node's
  row and zoomed title. The marker is a filled pie because a thin ring reads as
  a loading spinner at row size.
- **Wandering off.** When the node is not visible in the current view, the band
  reads "You set out to …" with Return. Return, the band title, the PiP window's
  "Back to focus", and the Cmd+K "Return to focus session" action zoom into the
  node and place the caret at the end of its text. Zooming means collapsed
  ancestors never need expanding.
- **Pause** is allowed. Paused time does not count as focus time.
- **Time is up.** The band counts overtime quietly ("+2:13") and never ends
  the session on its own. Choices are Done, +5 min, and Let go.
- **Two endings.** Done and Let go; ending early from the band is Let go.
  On a task node, Done and the band's checkbox mark the node Completed. On any
  other Kind, Done only ends the session. Let go never completes anything.
  Deleting the node ends the session with a toast; completing it elsewhere
  counts as Done.
- **Reflection.** After either ending, an optional one-line field (in the band
  or the PiP window) writes one plain bullet as the node's last child:
  "Focus session, Oct 22, 25 min: …", using actual focus time. Skip writes
  nothing. For a mirror, the child lands under the source. On a Locked node
  (ADR 0067), Done ends the session with a toast explaining that it could not
  be checked off, and no reflection is offered.
- **Pomodoro.** Breaks start on their own; each focus round waits for a click so
  starting stays intentional. Defaults: 25 min focus, 5 min break, 15 min long
  break after 4 rounds. Done ends the whole Pomodoro session, with one
  reflection.
- **Sounds** use Cuelume (MIT, Web Audio synthesis, no audio files): "attention"
  when time is up, "success" on Done, "ready" when a break ends. On by default,
  one switch, no countdown ticking. When the tab is hidden and no PiP window is
  open, the tab title also reads "Time is up - …". No system notifications.
- **Spoilers.** Band and PiP text use the MCP projection (`[spoiler]`), not the
  breadcrumb's revealing one. A floating window can be screen-shared.
- **Settings.** Focus sessions is a row under Settings → Plugins with an
  account-wide switch (`editor-feature:focus`, on by default). Its options hold
  the Pomodoro lengths, rounds before a long break, and Sounds, stored
  account-wide like ADR 0064's preferences. Each value saves when its field is
  left; an invalid entry restores the saved value. Turning the switch off hides
  the band, marker, and commands, and lets a running session go with no
  reflection, so a hidden clock never keeps cueing sounds. (Superseded: v1 had
  no switch because nothing renders until a session starts; the October 30
  Plugins redesign gave every plugin the same row.)
- **Mobile** has no PiP window and no actions-bar entry in v1; the band and the
  marker carry the session.

## Picture-in-picture opens by hand

The floating window uses the Document Picture-in-Picture API and copies the
card layout. It opens only from the band's Pop out button. `requestWindow()`
requires a user gesture, and Chrome opens one automatically on tab switch only
for pages with audible media or an active camera or microphone. Chrome then
asks inside the window whether to allow automatic entry every time, only this
time, or never; "every time" waives its media-engagement threshold. A future
optional focus sound could therefore enable automatic pop-out honestly, but it
is an experiment, not v1. The window never outlives the tab and is absent in
Safari and on phones.

## Session state stays in this browser

A running session is browser-local, shared across this browser's tabs, like
Spotlight and Scribble. It records absolute start and end times, so it survives
tab throttling and can move to the server without reshaping. The CLI, MCP, and
other devices do not see it yet; syncing and read-only agent access are tracked
in [#433](https://github.com/cameronapak/dotflowy/issues/433). Agents will be
able to read a session but never start, pause, or end one. Starting a focus is
the user's own intention. Reflections need no new storage because they are
ordinary nodes.

## Considered options

- **A secondary-background wash on the focused row.** No plugin seam can tint a
  row (ADR 0031 retired plugin CSS), and the wash sits close to the
  multi-selection tint. Rejected for the slot marker.
- **Dim everything else.** Duplicates Spotlight. Rejected.
- **Zoom in on start.** Jarring without an explicit request. Only Return zooms.
- **Auto-open the PiP window on tab leave.** Not possible for a silent page; see
  above.
