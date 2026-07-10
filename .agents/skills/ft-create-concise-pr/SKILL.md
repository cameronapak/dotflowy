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

## Screenshots

## Flow

## Breaking / Migration

## Test plan
```

Rules:

- **Title**: under 70 characters, written for the PR list. Name the outcome in whichever shape reads most naturally: the new reality ("Multi-line paste builds a tree"), the win as the verb ("Speed up caret pickers: maintained tag corpus"), or the thing gained ("Add dark mode"). Then the spoken test: read it aloud — if a teammate would look at you funny ("Mandate snapshot PR descriptions via ft-create-concise-pr"), rewrite it. No tool or skill names. Prefix with `type:` only if the repo's merged PRs do.
- **Summary**: max 2 sentences. What changed and why. No "This PR..." openers. Then the hallway test: read it aloud as if telling a PM in the hallway — if they couldn't retell it to someone else, rewrite. If the PR closes an issue, add `Fixes #N` on its own line — GitHub auto-closes it on merge.
- **Changes**: a numbered list, 1–7 items — numbers let a reviewer say "change 3" in a comment. One sentence each; if an item needs a second sentence, it's either two changes or Summary material. Order: behavior changes first, then logic changes, then refactors/chores. Lead with the outcome, trail the mechanism: "Highlights survive flaky networks (retry with backoff)", not "Added retry logic for highlights". The outcome names who benefits and how — a user keeping their moments, a developer getting faster builds. Never file names; the diff shows those. If one change deserves disproportionate scrutiny, add a line under the list: `**Start here:** change 3 — <the subtle part, in a few words>`. One item max — if you'd flag two, flag none. No line means no landmines.
- **Screenshots**: only when the change is visible on screen. Before/after for modified UI; one shot or short recording for new UI. The image replaces prose — don't also describe what it shows.
- **Flow**: only when the gate below passes.
- **Breaking / Migration**: only when the change breaks consumers or requires a migration step.
- **Test plan**: bullets, one verification per line (command run, flow exercised) — never prose. If anything is left for the reviewer to check, end with one bold line: `**Needs manual check:** <what and why>`. No such line means nothing is asked of the reviewer. If nothing was verified, write `Not tested`. Never invent verification.
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

- Keep the structure. Edit only the items affected by new commits.
- Keep change numbers stable — review comments may cite them. Edit items in place, append new ones at the end of their tier; renumber only when an item is deleted.
- Don't let the Summary grow.
- If a change reverses an earlier item, replace the item rather than appending.
- Refresh the Test plan if new verification happened, dropping the `**Needs manual check:**` line once the check is done. Refresh or delete the diagram if the flow changed, screenshots if the UI changed, and the `**Start here:**` line if it no longer points at the riskiest change.
- Leave bot-appended blocks (release notes, coverage reports — usually wrapped in HTML comments) untouched. They're not yours.
