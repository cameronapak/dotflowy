---
"dotflowy": patch
---

Fix Enter at the start of a bullet: it now inserts a blank bullet above and leaves the bullet you were on completely alone — same text, same children, same id — instead of blanking it and handing its text to a new bullet below (which detached children onto the blank line and silently moved node identity out from under bookmarks, links, mirrors, and daily mappings). The caret stays where you were typing.
