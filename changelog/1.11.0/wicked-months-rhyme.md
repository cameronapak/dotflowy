---
"dotflowy": minor
---

Backspace at the start of a bullet now joins it into the row above, the inverse of the Enter split — the two texts merge, the caret lands at the seam, and one undo puts both back. If the row above is blank, the blank is simply removed — so pressing Enter at the start of a bullet and then Backspace puts you back exactly where you were. A merge that can't happen says so instead of doing nothing: the row shakes, and where the reason is invisible (a bullet hidden by a filter or by "Show completed" sitting between the two rows, or a mirrored row) it also explains itself. Bullets with children, and the empty-bullet and to-do Backspace behavior, are unchanged.
