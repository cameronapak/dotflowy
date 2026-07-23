/**
 * Lunora row types for kv side-collections (ADR 0055 phase 2b).
 * Collections + mutators are wired in `lunora-outline-store.ts` (one
 * `bindMutators` / clientSeq FIFO with outline writes).
 */

export type TagColorRowDoc = {
  _id: string;
  tag: string;
  color: string;
  userId: string;
  _creationTime?: number;
} & Record<string, unknown>;

export type SavedQueryRowDoc = {
  _id: string;
  name: string;
  query: string;
  createdAt: number;
  userId: string;
  _creationTime?: number;
} & Record<string, unknown>;

/** Daily scaffold key → nodeId (ADR 0052). `_id` = key. */
export type DailyIndexRowDoc = {
  _id: string;
  key: string;
  nodeId: string;
  touchedAt: number;
  userId: string;
  _creationTime?: number;
} & Record<string, unknown>;
