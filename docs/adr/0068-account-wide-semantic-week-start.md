---
status: accepted
---

# Week start is an account-wide calendar meaning, not display order

Daily notes support an account-wide **Week start** of Sunday or Monday. This is
the meaning of a Calendar week everywhere, not a visual reorder of the week
strip: hierarchy, calendar grids, navigation, date language, badges, browser
writes, CLI, and MCP all derive the same seven-day period. Missing preferences
mean Monday. Existing Monday structure keeps the same grouping, but its legacy
ISO week keys and labels are still canonicalized to start-date identity before
new writes proceed.

This amends [ADR 0052](./0052-daily-calendar-hierarchy.md), which fixed persisted
weeks to ISO identity and deferred configurability; [ADR 0054](./0054-week-calendar-subheader-strip.md),
which required the strip to mirror that identity; and [ADR 0064](./0064-account-wide-editor-feature-preferences.md),
whose account preference model now also carries calendar meaning.

## Calendar identity

- A Calendar week runs Sunday–Saturday or Monday–Sunday according to Week start.
  Only those two starts are supported.
- Its identity is its start date, not a week number. New daily-index week keys
  use `week:YYYY-MM-DD`; the prefix keeps a week distinct from the Daily note
  with the same date. Existing ISO `YYYY-Www` keys are migration input, not a
  second permanent identity.
- Week nodes and compact week chrome use an unambiguous date range such as
  `Oct 11–17`, expanding the month or year where a boundary makes that necessary.
  There is no calculated `W41` companion whose numbering rule could contradict
  the chosen Week start.
- A week remains atomic under one month and year. Its fourth day owns it: Thursday
  for a Monday start and Wednesday for a Sunday start. This preserves the
  majority-of-days rule from ADR 0052 without splitting boundary weeks.
- "This week," "last week," month grids, paging, scaffold creation, and every
  other week operation use the account preference. A presentation-only Sunday
  row over Monday-based storage is rejected because one visible row would span
  two persisted Week nodes.

## Preference and migration

The setting lives inside Daily notes details under Editor features and remains
available while Daily notes is off. Changing it is a server-authoritative
operation in the per-user Durable Object, where the outline and `account-prefs`
already share one SQLite database. The preference row and structural migration
commit in one transaction; other browser tabs and external tools can therefore
observe the old calendar or the new calendar, never an activated preference over
a half-migrated hierarchy. The UI shows progress and reports failure while
retaining the old preference and structure.

Automatic legacy-key canonicalization is targetless: the Durable Object reads
the current preference inside its serialized turn instead of accepting a value
previously read by a client. Explicit changes and canonicalization are distinct
operations. Calendar migrations advance the outline sequence even when no node
must move, and their realtime frame carries the committed Week start plus index
delta. Active tabs apply that calendar state before the accompanying node frame;
reconnecting tabs receive the current state on their handshake. Daily creation
writes use a sequence or Week-start precondition so a plan made before a
concurrent switch is rejected rather than creating old-calendar scaffold.

Migration derives the target scaffold from Daily note date keys. Each existing
Week node maps to the new week sharing six of its seven dates, preserving that
node and any undated notes authored directly beneath it. Dated Daily notes move
to their newly derived Week. Month and year placement follows the new fourth-day
rule, sibling order remains chronological, missing scaffold is created, and
empty obsolete scaffold is removed. A Daily note that the user relocated outside
the Daily scaffold remains where the user put it, preserving ADR 0052's migration
boundary.

Switching back runs the same derivation in reverse. Preference migration is not
an editor undo step: it is account-wide state that may already govern writes from
another tab, CLI, or MCP. The user reverses it by choosing the previous Week
start.

## Consequences

- Client and Worker date math must accept explicit calendar semantics instead of
  treating ISO helpers as global truth. Worker creation must read Week start from
  the same authoritative operation boundary as scaffold writes.
- Week navigation and month grids remain display-only consumers of shared date
  math; they do not invent separate ordering rules.
- Migration tests must cover both directions, year and month boundaries, sparse
  weeks, direct Week-node notes, relocated Daily notes, concurrent creation, and
  transaction rollback. Existing Monday accounts require automatic key and label
  canonicalization, but their day grouping does not change.
- Locale inference, arbitrary first weekdays, split weeks, and week-number labels
  remain out of scope. They add ambiguity without serving the Sunday/Monday need.
