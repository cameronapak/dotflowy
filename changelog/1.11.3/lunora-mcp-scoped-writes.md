---
"dotflowy": patch
---

Fixed MCP tools failing on Lunora-synced accounts. Date-targeted tools (`add_to_today`, `add_subtree` with a date, `mirror_to_today`) and `delete_node` hit a SQLite compound-SELECT limit; writes now scope to their table, and tool errors report the real cause instead of "internal error".
