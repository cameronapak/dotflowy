/**
 * Live outline rows for event-time reads that must see optimistic writes
 * synchronously (selection refresh, markdown paste seam, multi-node mirror).
 *
 * Read the classic collection directly rather than `getTreeIndex()`, whose
 * notify can lag an optimistic apply.
 */

import type { Node } from "./schema";

import { nodesCollection } from "./collection";

/** Synchronously current nodes for selection and tree-index callers. */
export function getLiveNodes(): Node[] {
  // SAFETY: nodesCollection rows are schema-validated Node values (collection.ts), so toArray already yields Node[].
  return nodesCollection.toArray as Node[];
}
