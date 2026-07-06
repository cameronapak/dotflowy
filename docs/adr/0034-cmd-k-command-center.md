---
status: accepted
---

# Cmd+K command center (nodes + actions)

**What.** The Cmd+K node quick-switcher grows into a keyboard-first **command center**: one box over
**nodes** AND **actions**. Actions are both global/system (the header + More-menu items) and
node-contextual (indent, complete, delete, move, mirror, zoom, plus whole-node plugin `/` commands). A
node action runs against an **ambient target** (the bullet you came from, captured when the palette opens)
or against any node you drill into with `→`. Empty query is browsable: the focused node's actions
("Acting on: …") plus a "Commands" group of every global action, then Bookmarks. `node-switcher.tsx`,
still mounted once in `__root.tsx`.

**Why a BRIDGE, not a spine (the load-bearing decision).** There are three unrelated action models today —
`CommandSpec` (the `/` palette + selection menu, `src/plugins/types.ts`), `SearchAction` (Seam-J Cmd+K
virtual rows), and the core `NodeCommands` verbs (re-wrapped as the mobile bar). Unifying them into one
registry is a large, risky refactor with no payoff for *this* feature. Instead Cmd+K is an **additional
door**: thin adapters translate each existing model into one `CommandCenterAction` row
(`src/data/command-center.ts` for node actions, `src/components/command-actions.tsx` for globals), and the
underlying models are untouched. An action may live in several surfaces (Cmd+K + More menu + mobile bar) —
**duplication is accepted**; keyboard access is first-class. Rejected: a "thick" unified command spine.

**Why targeting is captured-then-frozen at open.** The palette is a Radix dialog; the instant it opens it
steals the caret, so `document.activeElement` is no longer the bullet. The ambient target is therefore
resolved ONCE — in the capture-phase `keydown`, before focus moves, reading the focused row's `data-node-id`
straight off the DOM — and frozen for the overlay's lifetime (never re-read while open). Resolution order:
focused bullet → the zoom root when zoomed → none (home view). Multi-select ambient (`runMany`) is
deferred: the node-selection actions menu (ADR 0018) already covers an active selection on-screen, so
Cmd+K-during-selection would be redundant chrome for v1.

**Why node actions cross a module bridge.** The switcher is mounted in `__root`, OUTSIDE `OutlineEditor`,
so it can't reach the per-bullet `NodeCommands` facade or the `PluginContext` factory the editor owns.
`OutlineEditor` PUBLISHES them (plus `findFocusedId` and a `focusNode` returner) to a module singleton
(`src/data/command-bridge.ts`, the `node-switcher-opener.ts` pattern); the switcher READS it to bind a node
action's `run()` to a target id. Node actions inherit `runStructural` atomicity (ADR 0009) and the
protected-node guards (ADR 0015) for free — the command center adds NO new mutation path.

**Why emphasis is excluded but todos/daily aren't.** A plugin `CommandSpec` opts into the palette by NOT
being `caretScoped`. Emphasis (`/bold`, `/italic`, …) wraps a *text selection inside* the bullet — but the
overlay stole the caret, so there's nothing to wrap; it stays slash-menu + hotkey only, marked
`caretScoped: true`. Whole-node commands (todos' To-do, daily's Send to Today) run fine and are surfaced.
De-dup rule: a plugin `CommandSpec` wins over the raw core verb for the same concept (To-do comes from the
todos plugin, not the core `onSetTask`), and plugin keymaps contribute NO rows — a keymap becomes the
`hotkey` display hint on its paired action row.

**Why `"use no memo"` on the dialog.** The React Compiler memoizes the cmdk list children and freezes the
first (target-less) render's list, so the ambient/command groups added on a later render never appear — the
same freeze that forces `OutlineEditor`'s opt-out (ADR 0019). The list is rebuilt from cheap state each
render, so the directive costs nothing on the hot path.

**Ranking / grouping / keyboard.** Group order is Ambient ("Acting on: …") → Actions/Commands → Nodes; Fuse
ranks within each group and the query-time Actions group is capped so node results are never buried.
Keyboard: ↑/↓ flat across groups, Enter runs an action or navigates to a node, `→`/Tab on a highlighted
node result opens its action sub-view, `←` (or Backspace on an empty box) steps back. `Escape` closes from
any level (Radix owns it). Covered by `e2e/command-center.spec.ts`.
