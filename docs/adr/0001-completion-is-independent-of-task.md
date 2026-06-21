# ADR 0001: Completion is independent of "task"

Status: accepted (2026-06-21)

## Glossary

- **Bullet** — any item in the outline (one `Node`).
- **Task** — a bullet that displays a checkbox. Controlled by `isTask`. Purely a display choice.
- **Completed** — whether a bullet is done. Controlled by `completed`. A plain `true`/`false` that applies to *any* bullet, task or not.

## Decision

`completed` and `isTask` are two independent booleans.

- A bullet is either completed or not. Nothing else determines done-ness.
- `isTask` only decides whether a checkbox is shown. It does not gate completion.

## What changed

- Dropped the old invariant "`completed` only carries meaning when `isTask` is true."
- `Cmd/Ctrl+Enter` now **toggles `completed`** on any bullet (complete / uncomplete).
- Toggling whether a bullet is a task moves to the slash menu only (no keyboard shortcut).
- `setIsTask` no longer clears `completed` when un-tasking. Done-status survives because it now stands on its own.

## Why

Completion is a universal property of an outline item (Workflowy model). Coupling it to the checkbox display made plain bullets un-completable and forced data-erasing safety rules. Decoupling removes both problems.
