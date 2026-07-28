/**
 * Disclosure for a refused Backspace-join.
 *
 * A Backspace at the start of a bullet that can't merge used to do nothing at
 * all -- which is the bug the ticket actually reported ("nothing happened"). The
 * app already has one vocabulary for a blocked action (`rejectRow`'s shake plus
 * a fixed-id `toast.error`, see protection.tsx / ADR 0015); a join refusal
 * borrows it rather than inventing a second.
 *
 * The split is on whether the reason is VISIBLE ON SCREEN, not on severity:
 *
 *   has-children   shake only -- the children are right there under the caret
 *   no-target      shake only -- you can see there's nothing above
 *   mirror-row     shake + toast -- "this row is a mirror" isn't obvious mid-keystroke
 *   hidden-between shake + toast -- the blocker is invisible by definition
 *
 * A toast for something the user can plainly see is noise, so the first two stay
 * bare. This is a deliberate new use of `rejectRow` WITHOUT a toast -- everywhere
 * else the two travel together.
 *
 * Lives beside protection.tsx rather than inside it: that module owns what
 * "protected" means (a plugin-declared seam), and a join refusal is neither
 * plugin-declared nor a protection rule.
 */
import { toast } from "sonner";

import type { JoinRefusal } from "../data/join-previous";

import { rejectRow } from "./flash-node";

/** The reasons that also get spelled out. A missing entry means shake-only. */
const TOASTED: Partial<
  Record<JoinRefusal, { message: string; description: string }>
> = {
  "mirror-row": {
    message: "Can't merge a mirror into the row above.",
    description:
      "This row is a live copy of another bullet, so merging it would duplicate its text. Edit the original instead.",
  },
  "hidden-between": {
    message: "Can't merge across a hidden bullet.",
    description:
      "Something between these two rows is hidden by an active filter or by 'Show completed'. Clear it first so the merge lands where you can see it.",
  },
};

/**
 * Signal a refused join on `rowEl`: always shake, and toast when the reason is
 * invisible on screen. The toast id is fixed per reason so holding Backspace
 * replaces the toast rather than stacking a dozen of them.
 */
export function signalJoinRefusal(
  reason: JoinRefusal,
  rowEl: Element | null,
): void {
  rejectRow(rowEl);
  const copy = TOASTED[reason];
  if (!copy) return;
  toast.error(copy.message, {
    id: `join-refused-${reason}`,
    description: copy.description,
  });
}
