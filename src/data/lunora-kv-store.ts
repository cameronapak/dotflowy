/**
 * Lunora row types for kv side-collections (ADR 0055 phase 2b).
 * Collections + mutators are wired in `lunora-outline-store.ts` (one
 * `bindMutators` / clientSeq FIFO with outline writes).
 *
 * dailyIndex stays on `/api/kv` until claimMapping ports.
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
