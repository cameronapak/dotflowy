# Handoff — Build quick-add (#253, ADR 0049)

**For:** a fresh agent implementing the quick-add capture surface. Design is fully locked; this is a build session.

## Read these first (do not re-derive — this handoff won't repeat them)

- **[ADR 0049](../Users/cameronpak/projects/dotflowy/docs/adr/0049-quick-add-capture-surface.md)** → `docs/adr/0049-quick-add-capture-surface.md` — the complete decision set + rejected alternatives.
- **Issue [#253](https://github.com/cameronapak/dotflowy/issues/253)** — the spec + suggested build order (seam → overlay → mini-editor → desktop wiring → mobile FAB → e2e).
- **CONTEXT.md** — the "Quick-add" glossary term.
- **ADR 0001** (plugin architecture / clean-core), **0009** (atomic structural writes), **0041** (daily seed-free vs write-intent surfaces), **0030** (mobile actions bar). All constrain this build — read before touching those surfaces.

## Status

- Design grilled + documented. **ZERO code written. No branch cut.** Working tree clean on `main` as of this session.
- ADR 0049, the CONTEXT.md entry, and issues #253/#254 are the only artifacts.

## Repo convention for this doc

This is `/tmp` for now because no branch exists. Per `CLAUDE.md` "Session handoffs", the moment you cut the feature branch, **move this to `HANDOFF.md` at repo root, committed on the branch** (and delete it in the shipping PR — it must never reach `main`).

## Concrete code seams to reuse (verified this session — start here, don't rediscover)

- **Overlay opener pattern:** `src/components/node-switcher-opener.ts` (`openNodeSwitcher`) + `move-dialog-opener.ts` (`openMoveDialog`). Both are the module-singleton opener + mounted-once-in-`__root.tsx` pattern quick-add should copy. `__root.tsx` mounts `<MoveDialog />`, `<SwitcherDialog />` etc.
- **Retarget picker:** `src/components/move-dialog.tsx` — `MoveDialogInner` holds the fuzzy target search. Extract the search (Fuse over nodes) for the inline `Today ▾` chip; do NOT open the whole modal.
- **Mini-editor source:** `src/components/OutlineEditor.tsx` `ZoomedTitle` (~line 1875+) — the single-`node-text` contentEditable path with source-offset caret (`readSource`, `getCaretOffset`), the reveal watcher, `slash`/`menus` engines, and its OWN inline `useHotkeys` keymap. The mini-editor is a curated fork of this. **This is the third render path (bullet → title → mini-editor)** — the two-render-paths trap becomes three; the curated keymap is the drift risk. Cam's directive: reuse via shared extraction where clean, don't hand-roll a third path, don't over-abstract for one consumer.
- **Today get-or-create (seed-free):** daily plugin `goToDate`/`ensureDay` (`src/plugins/daily/daily-index.ts`). Quick-add is a "leaves structure untouched" path like Send to Today — must NOT seed an entry line (ADR 0041). The new **"default capture destination" seam** wraps this so core never imports daily.
- **Mobile FAB positioning:** `useKeyboardViewport` + the coarse-pointer gating in the mobile actions bar (`MobileActionsBar.tsx`, ADR 0030) — reuse for the FAB and the mobile mini-editor keyboard anchoring.
- **Plugin seam registration:** `src/plugins/types.ts` (contract) + `src/plugins/registry.ts` (compose-at-load). The new destination-provider seam goes here.

## Build order (from #253)

1. New **"default capture destination" seam** in `types.ts`/`registry.ts` + daily fills it (seed-free Today).
2. Core overlay shell mounted in `__root.tsx` (opener singleton).
3. Mini single-node editor (extract from `ZoomedTitle`, curated text-authoring-only keymap).
4. Commit + live-move via `runStructural` (one batch each); born-on-first-keystroke; discard-if-empty; running session-capture list.
5. Desktop wiring: `Opt+Cmd+N` hotkey (register at app root like Cmd+K, not the title keymap) + Cmd+K action (via the command bridge).
6. Mobile FAB (coarse-pointer) + keyboard-anchored mini-editor.
7. e2e specs.

## Risks / gotchas to spike early

- **Third render path drift.** Keymap + caret menus + folding reveal must be wired like `ZoomedTitle` or they silently no-op (this is exactly the two-render-paths class of bug). Test tags/slash/links inside the mini-editor explicitly.
- **Discard-if-empty timing** with born-on-first-keystroke: no node exists until first input; on close/clear with empty text, ensure nothing was committed (and if a node was born then emptied, remove it — one `runStructural`).
- **Live-move chattiness:** changing destination mid-compose = a move op; keep it one `runStructural` and debounce if the picker fires rapidly.
- **`Opt+Cmd+N` interception:** register globally; verify it's not swallowed by the browser/OS on Cam's setup.
- **e2e can't reach the Worker** (`seedOutline` mocks `/api/nodes` + `/api/sync`); the daily-index kv path runs against the Map mock. New kv usage: if any new side-collection is added, it must go in the Worker `KV_COLLECTIONS` allowlist (this build likely adds none — the running list is ephemeral session state, not synced).
- **Mobile mini-editor is not e2e-testable** (keyboard/viewport) — manual iPhone checklist in the PR, like ADR 0030.

## Pre-PR gates (CLAUDE.md)

`typecheck`, `typecheck:worker`, `typecheck:test`, `lint`, `test`, `test:e2e` (local, `--workers=2`). Add a changeset (`bunx changeset`, likely `minor` — a new capability). Run `/verify` (drive it in `bun run dev`) before declaring done — this is an observable UI feature. Open the PR with `/ft-create-concise-pr`, then `/code-review`.

## Suggested skills for the next session

- **`/grill-with-docs`** is DONE — do not re-grill; the ADR is the output. Only re-open if a build discovery contradicts a locked decision.
- **`tdd`** or the repo's e2e-first habit for the capture-loop specs.
- **`shadcn` / `impeccable`** when building the overlay + FAB visuals (Cam explicitly wanted these for the surface design — but only at build-the-UI time, not for IA).
- **`/verify`** before commit.
- **`/ft-create-concise-pr`** + **`/code-review`** at PR time.
- **`react-doctor`** occasional health check (expect the known editor false-positives).
