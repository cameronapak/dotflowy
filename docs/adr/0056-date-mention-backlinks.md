# Date-mention backlinks: index by key, unified day list

Status: accepted (2026-07-25)

Date tokens (`[[YYYY-MM-DD]]`, ADR 0038) are pointers at a day, but the zoomed day’s “backlinks” line only counted `[[nodeId]]` referrers (ADR 0032). Mentions of the day key were invisible until you happened to also link the day node’s uuid.

- **Reverse index by date key:** `TreeIndex.dateMentionsByKey` maps `YYYY-MM-DD → referrer node ids`, built from `parseDateLinkKeys` in `date-links.ts` and maintained incrementally in `tree-store.ts` with the same Map-identity discipline as `linksByTarget`. Mentions never mint (ADR 0038) — the index is pure text derivation.
- **Unified list on a zoomed day:** when the zoom root reverse-maps (daily-index) to a day key, backlinks = `linksByTarget(dayNodeId) ∪ dateMentionsByKey(dayKey)`, deduped by referrer id, excluding the day node and its mirror instances. Non-day zoom roots stay node-link-only.
- **Rejected:** indexing by day node id (would require minting or a stale join); a second “date mentions” chrome line (one list is the product); Worker-side chrono or mention sync (client-derived like tags).
