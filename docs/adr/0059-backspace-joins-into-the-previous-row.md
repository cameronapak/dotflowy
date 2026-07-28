# Backspace joins a bullet into the previous visible row

Status: accepted (2026-07-27)

Enter splits a bullet at the caret (`splitNode`); Backspace had no inverse. At
the start of a bullet that **has text** the keymap fell through to native contentEditable — and native
has nothing to do there, because every bullet is its own editing host, so the deletion cannot cross the
boundary. The result was a silent no-op in every engine: Enter was not reversible by the key everyone
reaches for, and the app said nothing about it. This records the join, the rules that refuse one, and
the two gates that had to be tightened before the branch was safe to add.

## The target is the previous VISIBLE row — the same walk the post-delete focus uses

`planJoinPrevious` (`src/data/join-previous.ts`) resolves the target with `findVisibleNeighbor(…, "up")`,
the walk `onDeleteNode` already uses to decide where focus lands. Both Backspace flavors — delete-empty
and merge — therefore put the caret in the same place, which is the property that makes the key feel
like one gesture rather than two. Workflowy, Roam, Logseq, Notion and Bear all merge into the row above.

Three consequences, all deliberate:

- **The target can sit at a different depth.** A first child merges into its parent; a top-level bullet
  merges into the previous sibling's deepest last descendant. That is what the user sees, and every
  other outliner does the same.
- **A collapsed bullet is itself the target.** Its descendants aren't visible rows, so the walk lands on
  the collapsed node — the right answer, for free. Collapse is never disqualifying.
- **The zoomed title can be a merge TARGET, never a merge source.** `findVisibleNeighbor` prepends the
  zoom root to its sequence and the title span registers in `refs` under `rootId`, so the first child
  under a zoom root joins into the title and the seam caret lands there through `FocusPass`.

**Rejected: previous sibling only.** Simpler, but the two Backspace flavors would then move the caret to
different places, and it refuses the common "first child merges into its parent" case outright.

## A merge never crosses something hidden — two walks, compared

This is where reusing the delete path's walk stops being safe. `findVisibleNeighbor` respects
hide-completed and an active `?q=`, which is exactly right for **focus** (reversible, moves nothing) and
exactly wrong for a **merge** (destructive, relocates text across the tree). With hide-completed on, your
completed previous sibling is invisible and the row above is some earlier node; merging there puts your
text before a bullet that still structurally sits between them, and when you unhide, the text is in the
wrong place with no trace of why.

So the planner walks twice — once as rendered, once with `isHidden` a no-op and `filter` null — and
refuses `hidden-between` when the two disagree. When nothing is pruned the walks are identical by
construction, so the common path pays one cheap comparison and never over-refuses; two adjacent matching
bullets under an active filter still merge.

**Rejected: merge into the visible row above regardless.** What-you-see-is-what-you-get is defensible for
navigation, but here it silently relocates text past a node the user cannot see — the failure mode most
likely to be discovered days later. **Rejected: refuse every merge while a filter is active.** Simpler,
over-refuses the legitimate adjacent-matches case, and teaches users the feature is unreliable under
filters. **Rejected: merge into the true structural predecessor even when it's hidden.** Text would
vanish into a hidden node; strictly worse than refusing.

## Four refusals, and every one of them speaks

"Nothing happened" is the bug the ticket actually reported, so a refused merge has to read as refused.
`signalJoinRefusal` (`src/components/join-refusal.ts`) borrows the app's existing blocked-action
vocabulary — `rejectRow`'s shake plus a fixed-id `toast.error` (ADR 0015) — and splits on whether the
reason is **visible on screen**, not on severity:

| Reason           | Shake | Toast | Why                                                |
| ---------------- | ----- | ----- | -------------------------------------------------- |
| `has-children`   | yes   | no    | the children are right there under the caret       |
| `no-target`      | yes   | no    | you can see there's nothing above                  |
| `mirror-row`     | yes   | yes   | "this row is a mirror" isn't obvious mid-keystroke |
| `hidden-between` | yes   | yes   | the blocker is invisible by definition             |

The first two are **the one place in the app where `rejectRow` travels without a toast** — everywhere
else the two are a pair. A toast for something the user can plainly see is noise. If the bare shake ever
tests too quiet, promote it; don't assume it was an oversight.

`has-children` refuses rather than reparenting: a large, surprising structural edit behind an ordinary
keystroke is worse than a no. `mirror-row` was not in the design discussion and was added while building:
a mirror instance's text belongs to a shared source that **survives** the join, so merging it away would
copy the text into the target while it still exists everywhere else — a duplication bug, not a move. A
mirror as the _target_ is fine: appending edits the shared source, which is how editing a mirror already
works — with **one** exception the planner must own itself: a mirror of _this_ node rendering directly
above it resolves its content back to the source, so the plan would be self-referential (`setText(S, …)`
then `removeNode(S)` — node and text both gone). `guardMirrorSourceDelete` in the shell happens to refuse
that first, but a planner must not be able to emit a write-then-delete of one node and rely on a
downstream guard to catch it; `planJoinPrevious` refuses when `targetContentId === instanceId`, pinned by
a unit test.

## Two gates tightened, because the branch is now destructive

Both were tolerable when the worst outcome was a no-op. Adding the join made each of them choose between
_delete this node_ and _merge this node_.

- **The emptiness gate reads `readSource(el)`, not `el.textContent`** — ADR 0005's landmine, in the exact
  branch this work rewrote. A line whose whole text is a folded token renders shorter than it reads, and
  a widget atom with no plain-text child renders as `""` — which would have sent a non-empty bullet down
  the **delete** branch. Silent data loss, latent before this change.
- **`isCaretAtStart` fails closed.** It used to return `true` when there was no selection at all, and it
  never checked `isCollapsed`; `getCaretOffset` returns the literal `0` for three distinct states (no
  selection, a range outside the element, a genuine caret at 0), so containment and collapse have to be
  checked in the predicate. A false "at start" now produces a **merge**, and a non-collapsed selection
  ending at offset 0 would have merged while text was selected. `isCollapsedCaretAtStart` became
  redundant and was deleted; its one caller now uses the tightened predicate.

**Rejected: a sentinel return from `getCaretOffset` for "not our selection".** Correct at the root, but it
touches the Enter offset, `isCaretAtEnd`, the caret menus and the paste splice — a wide blast radius on
the hottest path in the editor, for a fix that belongs in one predicate. **Rejected: switching all three
raw `textContent` reads** (`Mod+A` emptiness and `isAllTextSelected` are the other two) — correct, but it
drags select-all semantics into a Backspace fix. Its own change.

## Bullet-only, stated rather than omitted

Only `useBulletKeymap` binds Backspace. The zoomed title and the quick-add mini editor deliberately do
not join — joining a zoom root into a node outside the current view is incoherent, and a capture draft has
no "bullet above" — and both say so in a local comment (`quick-add.tsx` stubs `onJoinPrevious: noop`)
rather than leaving the omission to be rediscovered. This is the bullet → title → mini-editor three-path
trap (ADR 0049): a future Backspace-adjacent interaction no-ops on the other two paths until it's added
there too.

Forward-delete is unchanged: there is still no bare `Delete` binding, and this work did not add the
symmetric "merge the bullet below into this one".

## One capture, one batch, guards at both ends

A merge is a delete of one node plus a text edit of another, so it runs the delete funnel's guards on
**both** subjects before touching anything, then applies `joinIntoPrevious` (`setText` on the target's
content id, `removeNode` on the source's instance id) inside a single `runStructural` with one `capture()`
— one undo step, one wire batch, no torn sibling chain in a concurrent tab (ADR 0009).

`guardProtected(target, "blank")` is load-bearing, not defensive: without it a merge appends to a
protected node's canonical text and the blur heal silently reverts it, losing the merged text outright.
The seam caret needs no new plumbing — it rides `setPendingCaretOffset`, the one-shot offset carrier
markdown paste already built for its weld seam (ADR 0044), in source space so it lands correctly when
either side ends or begins with a folded token.

**Rejected: coalescing the join with the Enter that immediately preceded it.** `history.ts` has no
coalescing mechanism to extend, it would need a time/adjacency heuristic, and it would make undo history
depend on how fast you typed. Enter stays its own undo step. **Rejected: guarding the source only** — see
the blur-heal data loss above.

The planner lives in its own leaf, `src/data/join-previous.ts`, rather than in `tree.ts`: the
hidden-between rule needs `findVisibleNeighbor`, and `visible-order.ts` already imports `tree.ts`, so a
planner there would close an import cycle. Pure and DOM-free, which is what lets `bun test` exercise the
combinatorics (`join-previous.test.ts`) instead of pushing them through Playwright.

## The Firefox report was not a Gecko bug

The ticket came from Firefox 152, which framed this as a possible engine defect. It isn't. The
browser-independent fall-through above explains it completely, and the empty-bullet path — the only place
a Gecko-specific failure was plausible, given Gecko's padding-`<br>` insertion into empty editable blocks
— was measured and **did not reproduce**.

Measured on Firefox 153 (Playwright's Gecko build) against Chromium 151 as a control, on a focused empty
bullet in both shapes (created by a real `Enter`, and pre-seeded then clicked), all four reads are
byte-identical across engines: `el.childNodes.length === 0` (no padding `<br>`), `el.innerHTML === ""`,
`getSelection().rangeCount === 1`, and `getRangeAt(0).startContainer === el`. The whole keyboard suite
(18/18) passes on Gecko, including the real-keyboard Enter-then-Backspace round trip. One correction to
the folklore: **both** engines return zero client rects for a collapsed range in an empty inline editing
host, so that documented divergence should not be cited as live.

`playwright.config.ts` therefore stays chromium-only, per its own policy comment ("add more projects only
if a bug turns out to be engine-specific"). The temporary `firefox` project and the probe spec that took
these readings were reverted — a green cross-engine assertion with no failing counterpart is maintenance
cost with no signal. **To re-run it:** add a `firefox` project with `testMatch` scoped to
`keyboard-nav.spec.ts` + `enter-split.spec.ts`, `bunx playwright install firefox`, and read
`document.activeElement`'s `childNodes.length` / `innerHTML` plus `getSelection()`'s `rangeCount` /
`getRangeAt(0).startContainer` from a `page.evaluate` after a real `Enter`. It's about forty lines.
