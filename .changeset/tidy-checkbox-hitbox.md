---
"dotflowy": patch
---

Clicking or drag-selecting the first characters of a to-do's text no longer completes it by accident. The checkbox had an invisible hit area reaching 12px past itself on every side — far enough to sit on top of the text beside it — so a click meant to place a caret landed on the checkbox instead. Its target is now the checkbox itself, and on touch it stays a comfortable 24px wide without growing the box or crowding the text.
