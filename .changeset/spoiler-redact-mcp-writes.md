---
"dotflowy": patch
---

Harden two Worker egress paths: MCP write-tool confirmations (add_node, add_subtree, move_nodes, mirror_node, import_opml) now redact spoiler runs in the destination parent's text, matching the read tools; and the unfurl SSRF guard strips a trailing dot from the hostname so an FQDN like `foo.internal.` can't slip the internal-name checks.
