---
"dotflowy": patch
---

Drag-reorder now follows the active filter: while a `?q=` filter is on, drops target only the visible rows (landing right after the visible predecessor when the real tree has hidden siblings in between), and a drop that lands the node hidden shows a quiet toast instead of silently vanishing it.
