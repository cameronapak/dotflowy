---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when the user wants to pin down domain terminology, sharpen fuzzy language, or record an architectural decision. In this repo, decisions land in docs/DECISIONS.md (one file) — there is no separate glossary or numbered ADRs.
---

# Domain Modeling

Actively sharpen the project's domain model as you design — challenging terms, inventing edge-case scenarios, cross-referencing the code. This is the *active* discipline: you're changing the model, not just consuming it.

**This repo's convention (read first).** dotflowy keeps **one** decisions file, [`docs/DECISIONS.md`](../../../docs/DECISIONS.md), and deliberately has **no** separate glossary (`CONTEXT.md`) and **no** numbered ADRs (`docs/adr/`). Don't create them. The bar for recording and the entry shape are defined at the top of `docs/DECISIONS.md` itself — follow it.

## During the session

### Sharpen fuzzy language

When the user uses a vague or overloaded term, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things." Sharpened terms guide the work and the naming in code; they don't get written to a standalone glossary.

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

## Recording a decision

Record to `docs/DECISIONS.md` **only when an agent reading the code alone would get it wrong** — the *why* is non-obvious and the obvious "fix" breaks something. One tight entry: the decision, why it's not visible in the code, and the tempting-wrong-path it rejects.

- If the code already makes the call obvious, **don't write it down** — the code is the doc.
- When a decision changes, edit its entry in place (or delete it). History — including superseded decisions and their rejected alternatives — lives in `git log`, not a pile of superseding files.
