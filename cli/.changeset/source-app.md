---
"dotflowy": minor
---

Commands that create nodes now send `sourceApp: "Dotflowy CLI"`, which the server requires. Pass `--source-app` to name another app, for example when an agent drives the CLI. Earlier CLI versions cannot create nodes once the server requires `sourceApp`; update to this version.
