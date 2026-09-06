/**
 * Lunora row types for kv side-collections (ADR 0058 phase 2b).
 * Collections + mutators are wired in `lunora-outline-store.ts` (one
 * `bindMutators` / clientSeq FIFO with outline writes). `_id` uses the
 * generated branded Id so these compare cleanly with the generated row types.
 */

import type { Id } from "../../lunora/_generated/dataModel";

export type TagColorRowDoc = {
  _id: Id<"tagColors">;
  tag: string;
  color: string;
  userId: string;
  _creationTime?: number;
};

export type SavedQueryRowDoc = {
  _id: Id<"savedQueries">;
  name: string;
  query: string;
  createdAt: number;
  userId: string;
  _creationTime?: number;
};

/** Daily scaffold key → nodeId (ADR 0052). Collection getKey = `key`. */
export type DailyIndexRowDoc = {
  _id: Id<"dailyIndex">;
  key: string;
  nodeId: string;
  touchedAt: number;
  userId: string;
  _creationTime?: number;
};
