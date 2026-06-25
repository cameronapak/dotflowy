---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design. Records only the few decisions an agent would get wrong from the code alone, into docs/DECISIONS.md.
disable-model-invocation: true
---

Run a `/grilling` session to sharpen the plan or design. The grilling is for *thinking* — it does not mint a doc per decision.

Capture the result with restraint:

- Write a decision into `docs/DECISIONS.md` **only when** an agent reading the code alone would get it wrong — the *why* is non-obvious and the obvious "fix" breaks something. One tight entry: the decision, why it's not visible in the code, and the tempting-wrong-path it rejects.
- If the code already makes the call obvious, do **not** write it down. The code is the doc.
- Do **not** create per-decision ADR files or a separate glossary. `docs/DECISIONS.md` is the single home; `git log` is the history.
