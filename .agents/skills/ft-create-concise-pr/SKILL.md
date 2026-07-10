---
name: ft-create-concise-pr
description: Create or update a pull request with a concise, skimmable snapshot description. Use when opening a PR, writing or rewriting a PR description, or refreshing a PR description after review changes.
metadata:
  fruit: self-control
---

# Snapshot PR

A PR description is a snapshot: one glance gives the reviewer the whole picture. A concise description is kindness to the people who review your work.

## Gather

Know the whole change before writing a word:

1. Find where the branch forked: `git merge-base HEAD <default-branch>` (default branch via `gh repo view --json defaultBranchRef`).
2. Read the full diff and commit messages since the merge base.
3. If a PR already exists (`gh pr view`), read its current description and review comments. If the description is already a snapshot (matches the template below), jump to **Update** below. If it isn't, rewrite it with **Write**, keeping facts from the old description that are still true — and never dropping images or links you can't regenerate.

Done when every changed file is accounted for in your understanding — not necessarily in the description.

## Write

Use exactly this template. Omit sections that don't apply. Never add sections.

```md
## Summary

## Changes

## Flow

## Breaking / Migration

## Test plan
```

Rules:

- **Title**: imperative mood, under 70 characters.
- **Summary**: max 2 sentences. What changed and why. No "This PR..." openers. If the PR closes an issue, add `Fixes #N` on its own line — GitHub auto-closes it on merge.
- **Changes**: 1–7 bullets, one line each — as few as the change honestly needs. Order: behavior changes first, then logic changes, then refactors/chores. Lead with the outcome, trail the mechanism: "Highlights survive flaky networks (retry with backoff)", not "Added retry logic for highlights". The outcome names who benefits and how — a user keeping their moments, a developer getting faster builds. Never file names; the diff shows those.
- **Flow**: only when the gate below passes.
- **Breaking / Migration**: only when the change breaks consumers or requires a migration step.
- **Test plan**: one line stating what was actually verified (commands run, flows exercised). If nothing was verified, write `Not tested`. Never invent verification.
- No filler, no adjectives.

### Flow diagram gate

Include a Mermaid diagram (GitHub renders it natively) only when the change alters flow across 3 or more components, or reorders a sequence of operations. Max 8 nodes. Show the new flow only — no before/after pairs. Never diagram what one bullet already explains.

## Apply

Post it:

- New PR: push the branch if it isn't pushed, then `gh pr create`. If HEAD is the default branch, stop and ask the user before branching.
- Existing PR: `gh pr edit --body-file`, adding `--title` if the current title breaks the title rule.

Done when the PR on GitHub shows the snapshot description.

## Update

When a PR that already has a snapshot description changes:

- Keep the structure. Edit only the bullets affected by new commits.
- Don't let the Summary grow.
- If a change reverses an earlier bullet, replace the bullet rather than appending.
- Refresh the Test plan if new verification happened. Refresh or delete the diagram if the flow changed.
