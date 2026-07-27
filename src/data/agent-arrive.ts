/**
 * Soft entrance for agent answer nodes after `softReloadLunoraOutline`.
 * Scoped to one answer root (and its descendants) so a full outline reload
 * doesn't re-animate every historical `origin: "agent"` bullet.
 *
 * Purely visual — never focuses, flashes, or scrollsIntoView.
 */

import { getTreeIndex } from "./tree-store";

let arriveRootId: string | null = null;
let arriveUntil = 0;

/** Mark the next soft-reload answer subtree for a fade/slide entrance. */
export function noteAgentAnswerArrive(rootId: string): void {
  arriveRootId = rootId;
  arriveUntil = Date.now() + 4_000;
}

export function clearAgentAnswerArrive(): void {
  arriveRootId = null;
  arriveUntil = 0;
}

/** True while `nodeId` is under the pending arrive root (and the window is live). */
export function shouldAgentArrive(nodeId: string): boolean {
  if (!arriveRootId || Date.now() > arriveUntil) {
    if (arriveRootId && Date.now() > arriveUntil) {
      arriveRootId = null;
    }
    return false;
  }
  if (nodeId === arriveRootId) return true;
  const index = getTreeIndex();
  let cur = index.byId.get(nodeId);
  let guard = index.byId.size + 1;
  while (cur && guard-- > 0) {
    if (cur.id === arriveRootId) return true;
    cur = cur.parentId ? index.byId.get(cur.parentId) : undefined;
  }
  return false;
}
