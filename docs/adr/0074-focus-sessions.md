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
  move you or change the node. Focus session actions use a stopwatch icon to
  distinguish timed work from Spotlight's view-mode icon. An hourglass was
  considered, but can also suggest waiting rather than starting a session.
- **One at a time.** Starting a new session while one runs shows
  "Replaces: …" in the picker. The old session ends as Let go with no
  reflection prompt. While a session runs, the View menu also offers
  "End focus session".
- **Visible everywhere.** The session renders as a depleting band in the
  subheader and as a draining pie marker in the `after-text` slot of the node's
  row and zoomed title. The marker is a filled pie because a thin ring reads as
  a loading spinner at row size.
- **The band stands out without a hue.** While a session runs, the band is a
  solid `primary` fill with `primary-foreground` text, so it contrasts with
  the page in both modes (about 17:1 light, 14:1 dark) while the default theme
  stays black, white, and gray. In dark mode `primary` is near-white, so the
  band reads as a bright bar, like a primary button. Progress drains as the
  same faint `primary-foreground` wash as the PiP window, behind the whole
  band (November 2026; it was a 4px line). Time is up fills the wash across
  the band; the label goes full strength and Done
  becomes the filled button. Focused controls on the fill draw a 2px offset
  outline in the text color. The in-page reflection field keeps the page
  surface. The title keeps at least 18rem, so crowded controls wrap below
  it instead of truncating it, and it uses `dir="auto"` with a `title`
  tooltip. Timers past an hour read `h:mm:ss`.
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
  reflection. When a break ends, the band reads "Next … Ready" and Start
  round N is the filled button, with Done outlined beside it: continuing is
  the expected step, and ending the whole session is the quieter choice.
- **Sounds** use Cuelume (MIT, Web Audio synthesis, no audio files): "attention"
  when time is up, "success" on Done, "ready" when a break ends. On by default,
  one switch. When the tab is hidden and no PiP window is open, the tab title
  also reads "Time is up - …". No system notifications. These cues are
  separate from focus sounds below; the Sounds switch governs only the cues.
- **Focus sounds** are optional ambient sound while you focus: Clock tick (one
  identical tick each second, not a tick-tock), Rain, and Brown noise. See
  "Focus sounds follow the focus" below.
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
time, or never; "every time" waives its media-engagement threshold. Focus sounds
play through Web Audio, not a media element, so they do not qualify; routing
them through an `<audio>` element could enable automatic pop-out later. The
window never outlives the tab and is absent in Safari and on phones.

The whole window is the same `primary` fill as the running band, with the
band's on-fill controls and focus outline, in every state: running, paused,
time is up, break, reflection, and no session. A floating window sits on the
desktop and over other apps, not on the page, so the page surface blended in;
switching to the page surface for reflection would hide the window exactly when
it asks for input. The reflection field's border is `primary-foreground` at
60%, so the field boundary stays above 3:1 on the near-white dark-mode fill.

The window leads with the node, because what you set out to do matters more
than how long is left. Its title is the largest and boldest text in the window
and scales with the window's size, clamped to 2 lines in a short window and up
to 5 in a tall one, with `dir="auto"` and a `title` tooltip. Tags stay at
normal weight and 60% opacity so the words lead. The time is a small pill
beside the status and parent line; at time is up it fills and turns medium
weight. Progress drains as a faint `primary-foreground` wash behind the whole
window instead of a line, and the wash fills the window at time is up. Back to
focus is a quiet text button, so the state's own actions, such as Done, stay
the strongest controls. Reflection keeps the stacked layout. The window drops
the page's reserved scrollbar gutter, which would otherwise leave an empty
strip down its edge where scrollbars always show.

## Focus sounds follow the focus

A focus sound plays only while focus time runs. It pauses with the session,
rests through Pomodoro breaks and comes back when the next round starts, goes
quiet at time is up so the "attention" cue marks that moment (pressing play
carries it into overtime), and stops when the session ends or is replaced,
even by a session started with Sound Off in another tab.

- **Controls.** The picker has a Sound row: Off or one of the sounds. Its choice
  is remembered and starts the sound with the session, since the Start button is
  the gesture browsers require before audio. The band has a play/pause button
  named for the sound and a chevron that opens the sound list and a volume
  slider (a bottom sheet on phones); choosing a sound plays it. The PiP window
  has a play/pause icon and a native select, because a popover would open in
  the page rather than the window; in overtime only play/pause stays, since
  Done, +5 min, and Let go fill its footer. Cmd+K offers "Play/Pause focus sound" and
  "Focus sound: …" while focusing.
- **Remembered in this browser.** The sound, volume, and whether the picker
  starts one are stored in `localStorage`, like the last session length. Playing
  is never restored after a reload: autoplay needs a gesture, so the band shows
  Play instead.
- **One tab plays.** Pressing play claims the sound over a `BroadcastChannel`;
  another tab that was playing goes quiet, so two tabs never double the rain.
- **Generated, not recorded.** Each sound is synthesized once with Web Audio
  into a seamless loop (1 second for the tick, 12 to 20 seconds for noise), with
  an equal-power crossfade at the seam. Nothing ships as an audio file, nothing
  needs a license, and the bundle grows by a few kilobytes of code. The tick's
  loop starts on the timer's second, and the loop itself keeps time, so a
  throttled tab never drifts. The audio context suspends when nothing plays.
- **Mobile.** On iOS 17+ the audio session is set to `playback`, so sounds play
  through the silent switch like a media app.
- **Not automatic PiP.** Chrome's automatic picture-in-picture needs an audible
  media element with audio focus; Web Audio does not count. The window still
  opens by hand.

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
- **A 30% muted wash for the band.** The v1 band. It measured 1.01:1 against
  the page, so a running session blended in. Replaced by the primary fill.
- **An orange tag-palette band, or an inset timer card with a ring.** Both
  stood out, but they introduce a chromatic accent into a grayscale product.
  Orange stays the one free hue if Time is up ever needs color; blue, purple,
  red, and green already carry meaning. Rejected for now.
- **A page-surface PiP window.** The v1 window used `background`, the same
  surface as most light or dark desktop windows, so it blended into the
  desktop. Replaced by the primary fill.
- **A timer-first PiP card.** The first primary-fill card sized the time
  (`text-xl`) above a two-line title at body size, so the clock outranked the
  task. Three task-first layouts were prototyped side by side: a large heading
  with a quiet footer, this poster with a wash, and the title on an inverted
  inner card. Cameron chose the poster.
- **Zoom in on start.** Jarring without an explicit request. Only Return zooms.
- **Auto-open the PiP window on tab leave.** Not possible for a silent page; see
  above.
- **A café sound.** A synthesized murmur of voices, cups, and room tone was
  prototyped. Generated chatter sounded fake, and a convincing café needs a
  licensed recording (0.3 to 1 MB). Cameron dropped it.
- **A tick-tock clock.** The first tick alternated two pitches. Cameron chose
  the same tick every second.
- **Licensed audio files.** Recordings of rain or noise would cost download
  size and license tracking for sounds that synthesis covers well. Rejected
  until a sound needs one.
