import type { WeekStart } from "./date-links";

export interface CalendarSyncState {
  weekStart: WeekStart;
  upserts?: ReadonlyArray<{ key: string; nodeId: string }>;
  deletes?: ReadonlyArray<string>;
}

const listeners = new Set<(state: CalendarSyncState) => void>();

/** Publish calendar state carried on the outline stream before its node frame is
 * applied, so every active consumer crosses the semantic boundary together. */
export function publishCalendarSync(state: CalendarSyncState): void {
  for (const listener of listeners) listener(state);
}

export function subscribeCalendarSync(
  listener: (state: CalendarSyncState) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
