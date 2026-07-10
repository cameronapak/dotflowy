# .changeset/

The **inbox**. One markdown fragment per PR that is news, authored with
`bunx changeset` and reviewed like any other file.

```md
---
"dotflowy": minor
---

Bullets can now be pasted as markdown.
```

The bump level is a **disclosure**, not a compatibility promise — nobody can pin
Dotflowy (ADR 0046):

- **major** — a reader has to _do_ something: relearn a gesture, fix an agent
  prompt, re-export a file, update a tool call.
- **minor** — a new capability; nothing to do.
- **patch** — it just got better.

Not every PR is news. A `chore:`, a refactor, a dependency bump: run
`bunx changeset --empty` to add a fragment that says so out loud. CI requires a
fragment; it does not require you to invent a changelog entry.

Fragments are consumed by `bun run release`, which **archives them to
`changelog/<version>/` first** — that archive is the app's data. Never run
`changeset version` directly.
