# Quick-add: a distraction-free capture surface, defaulting to Today via a plugin seam

The pain: to add one thing to Today you open the app, click Today, and the day's existing clutter grabs your attention — so you forget the thing you came to write. Quick-add is a focused overlay that captures a real node in one uninterrupted gesture and **never shows you Today** unless you choose to look. It defaults to Today but can target any node; relocating is an optional after-the-fact step, not a decision on the hot path. This is deliberately **Today-default, not Inbox-default** — a divergence from the category norm (Workflowy/Todoist/Things all capture to an Inbox), coherent for a Today-centric user, with "relocate optional" as the pressure valve.

## The decisions

1. **Commit-immediately, relocate optional — not compose-then-place.** On confirm the node is already real and in its destination; placement is never a required step in the capture ritual. The stated pain is _distraction_, and the zero-decision default (everything to Today, untouched) is what removes friction at the exact moment it hurts. Rejected hold-in-buffer (forces a location decision every capture) and an Inbox bucket (adds a triage habit the user doesn't want).

2. **The surface is a full mini single-node editor, not a plain input.** Real editor machinery scoped to one node so `#tags`, `[[`links, `/paragraph`, emphasis/highlight/spoiler, folding, and the caret menus all work live while composing. It reuses the `ZoomedTitle` render path (source-offset caret, reveal watcher, caret menus) heavily. This makes quick-add a **third render path** for a node (list bullet → zoomed title → mini-editor); the two-render-paths trap becomes a three-path trap, and the curated-keymap wiring is the likeliest place for drift. We reuse via shared extraction where clean rather than hand-rolling a third path or over-abstracting for one consumer.

3. **The node is born on first keystroke in the current destination**, edited live-synced. Not born-on-open (guarantees an empty-node flicker + always needs cleanup). An untouched or fully-cleared capture leaves **nothing** in the tree — discard-if-empty, the daily seed-line discipline. Changing the destination mid-compose **live-moves** the node.

4. **Text-authoring keymap only.** Structural nav (indent/outdent, move up/down, zoom, cross-bullet arrows, expand/collapse) is suppressed in this surface — the node is a live child of Today, so those commands technically act on it in Today's context, which is confusing or actively breaks the flow (Tab would indent your capture under Today's previous child; zoom would navigate away). Curate the slash list + gate the structural hotkeys for this surface.

5. **Rapid-fire: Enter = commit & next, Esc closes.** Single node per commit; Enter clears the editor for the next capture and the overlay stays open for a burst. Each thought is its own sibling, appended at the **bottom** of today (chronological log). Rejected Enter = new line (reintroduces the full outline's complexity into a distraction-free surface) and Enter = commit & close (re-press the hotkey per thought, worse for a burst).

6. **Destination resets to Today on each new node**, and an inline `Today ▾` chip retargets the current node via a compact fuzzy picker reusing `MoveDialogInner`'s target search (not its modal chrome — no modal-over-modal). Reset keeps the zero-decision default sacred; per-node override is the exception. Rejected session-sticky destinations (silent mis-filing after one context shift).

7. **Proof-of-capture without the clutter: a quiet running list of _this session's_ captures** inside the overlay, with inline relocate per row, cleared when the overlay closes. Fire five thoughts fast and still confirm they landed — without peeking at Today, which is the whole point. Rejected toast-only (nothing to glance at) and pure-void (the "did that save?" itch pulls you out to check Today).

8. **Every commit and live-move is one `runStructural` batch** (ADR 0009) → one Cmd+Z each. Today is get-or-created **seed-free** (like Send to Today, ADR 0041 — quick-add is a "leaves structure untouched" path, not one of the three write-intent surfaces that seed an entry line), so a freshly-created day gets the capture as its first child with no stray empty line.

## Architecture: core surface, Today-default via a new plugin seam

Quick-add is **core chrome**, mounted in `__root.tsx` like the Cmd+K command center — a general capture surface (own hotkey, own overlay, a mobile FAB, a Cmd+K action) is a category error inside the daily plugin, and the plugin seams don't cleanly host a global overlay + hotkey + FAB.

But "default to Today" is a **daily-plugin concept**, and the clean-core rule (ADR 0001) forbids core importing a plugin. So the default destination is resolved through a **new seam — a "default capture destination" provider** the daily plugin fills ("the capture default is today's note; get-or-create it seed-free"). Core never imports `daily`; if the seam has no provider, quick-add falls back gracefully (e.g. root / last-used). This seam goes in `src/plugins/types.ts` + `registry.ts` alongside the others. Rejected a direct `goToDate` import from core (the exact core→plugin coupling ADR 0001 forbids — a precedent that erodes the boundary) and shipping quick-add inside the daily plugin.

## Reach

- **Desktop:** `Opt+Cmd+N` (Workflowy Quick Add parity, so switchers keep their muscle memory) + a Cmd+K action. **No new desktop header button** — Cmd+K already has one and quick-add is a Cmd+K action, so the header stays exactly as it is.
- **Mobile:** a floating capture button (FAB), shown when not editing (there's no hotkey on mobile, and the mobile actions bar only appears while already editing). Full rapid-fire parity, keyboard-anchored like the mobile actions bar (ADR 0030).

## Non-goals (v1) and deferred

- **In-app only.** A web SPA can't do OS-global capture the way Workflowy's Electron app does (`Opt+Cmd+N` fires app-unfocused there). The stated pain is in-app anyway. True from-anywhere capture (desktop shell / browser extension) is a separate, much larger effort.
- **No clipboard magic** (auto-insert clipboard text, HTML→Markdown, page-title grab on open). Pasting a URL still unfurls its title via the links plugin; you just paste manually.
- **The mobile bottom tab bar** (Workflowy-style, to de-clutter the mobile header) is an information-architecture effort of its own — its own ADR, its own grill. Explicitly not coupled to quick-add.
