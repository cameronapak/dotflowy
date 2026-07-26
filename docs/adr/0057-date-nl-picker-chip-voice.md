# Date NL: weekday picker, dual period resolve, chip voice

Status: accepted (2026-07-25)

Follow-on to ADR 0055 (Cmd+K go-to-date + gated `[[` chrono) and ADR 0038 (date token). Grilling locked five product calls that the first ship left incomplete.

- **`[[` weekday gate:** calendar-complete now means day-of-month, explicit year, **or weekday**. Bare `Thursday` / `next Thursday` / owned stems (`thursd`) insert a day chip; bare `April` stays blocked (nodes can still match). Owned ≥3-char English weekday prefixes (optional `next`/`last`) are shared by Cmd+K and the picker so chrono gaps (`thursd`, `mond`) resolve.
- **Dual period resolve:** `next|last` × `week|month|year` is computed from ISO helpers in `date-links.ts` (not chrono’s mid-week “next week” day). **Cmd+K** navigates the scaffold key (week/month/year). **`[[`** inserts the **period-start day** chip (ISO Monday / 1st of month / Jan 1). Catalog trio: typing exactly `next`/`last` (optional trailing space) or a suffix that still prefixes week/month/year offers up to three labeled rows; bare `ne` stays quiet.
- **Chip vs badge voice:** day-note badges keep Today/Yesterday/Tomorrow (`formatDayBadge` / `formatDateLabel`). Date chips (`DateLinkChip`) and `flattenDateLinks` use `formatDateChipLabel` — Today/Tomorrow; past `one day ago`…`six days ago`; future `in two days`…`in six days`; beyond ±6 a short absolute (year when other-year). Hover stays `formatDateFull`.
- **Scaffold-only mint:** Cmd+K to a missing week/month/year mints the Daily > Y > M > W chain via `getOrCreateScaffold` **without** forcing a day child. Day go-to still uses `getOrCreateDay`.
- **Fuse day aliases:** existing day nodes expose weekday stems (`thu`…`thursday`) in `searchAliases` so virtual go-to stays suppressed when the mapped day exists.

Rejected: chrono’s raw period day for either surface; unifying chip and badge “Yesterday”; requiring a day mint to open a week page.

**Bounded cross-plugin read:** node-links imports `getMappedId` from daily-index only to dedupe the `[[` picker (suppress the mapped day uuid when a date row resolves). Same family as core `backlinks.tsx` → `useScaffoldKey` — deliberate, not a seam.
