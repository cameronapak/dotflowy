/**
 * Blank healing for protected nodes. A protected node (the daily "Daily"
 * container) can't be deleted; it equally can't be left nameless. But silently
 * snapping the name back the instant it's emptied hides the *why* -- so this
 * runs on BLUR (a commit boundary): if the node was left empty, restore the
 * canonical name AND signal the rejection (shake the row + toast), mirroring the
 * delete path's feedback. Editing stays unfought mid-keystroke, and renaming
 * works -- type a new name, blur, it sticks (only an empty heals).
 *
 * A no-op for unprotected nodes, protected nodes with no canonical name, and
 * non-empty text -- the 99% case -- so it's cheap to call from every blur.
 */
import { setText } from "../data/mutations";
import { getProtection } from "../plugins/registry";
import { signalRejection } from "./protection";

/**
 * If `id` is a protected node left blank, restore its canonical text (store +
 * DOM), shake its row, and toast why. `text` is the source already read by the
 * caller (so folded links are counted correctly). Returns the restored text, or
 * null when nothing changed.
 */
export function healProtectedText(
  id: string,
  text: string,
  el: HTMLElement,
): string | null {
  const protection = getProtection(id);
  const canonical = protection?.canonicalText;
  if (!canonical || text.trim() !== "") return null;
  setText(id, canonical);
  el.textContent = canonical;
  // Restored, not deleted -- but a blank is still a rejected edit, so it gets
  // the same shake + toast as the other blocked actions (core owns the copy).
  signalRejection(el.closest(".outline-row"), protection, "blank");
  return canonical;
}
