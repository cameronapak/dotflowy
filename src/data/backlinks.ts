// Unified backlinks (ADR 0032 + ADR 0056): node-link referrers ∪ date-mention
// referrers for a zoomed day. Pure — tree-store maintains the reverse indexes;
// the UI passes the day's key from daily-index when the zoom root is a day.

import type { TreeIndex } from "./tree";

/**
 * Referrer node ids for `targetId`: `linksByTarget` plus, when `dayKey` is set,
 * `dateMentionsByKey` for that local date. Deduped by referrer; excludes the
 * target itself and its mirror instances.
 */
export function collectBacklinkReferrerIds(
  index: TreeIndex,
  targetId: string,
  dayKey: string | null = null,
): string[] {
  const exclude = new Set<string>([targetId]);
  for (const mid of index.mirrorsBySource.get(targetId) ?? []) {
    exclude.add(mid);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => {
    if (exclude.has(id) || seen.has(id)) return;
    if (!index.byId.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of index.linksByTarget.get(targetId) ?? []) add(id);
  if (dayKey) {
    for (const id of index.dateMentionsByKey.get(dayKey) ?? []) add(id);
  }
  return out;
}
