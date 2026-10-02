---
"dotflowy": minor
---

MCP and CLI search now use DQL, the app filter's query language. Find incomplete tagged tasks with `is:todo -is:complete #dotflowy`, scope searches to a subtree, and retrieve every match through pagination. Mirrors match source content, and spoiler interiors remain redacted before matching.

If an agent prompt or script searches for a multiword phrase, add DQL quotes: use `"release notes"` instead of `release notes`, which now means both words anywhere in the same node. MCP search returns 25 matches by default, with `nextCursor` for continuation. CLI search adds `--node`, `--limit`, `--cursor`, and `--all --json`.
