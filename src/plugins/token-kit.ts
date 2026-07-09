// Shared helpers for token plugins (ADR 0001). One blessed home for the small
// pieces the folding + editable tokens all need, so the rule lives in one place
// instead of N copies. Pure/DOM helpers only — no UI barrel imports.

import { getTreeIndex } from "../data/tree-store";
import { getViewRootId } from "../data/view-state";
import type { NodeCommands } from "../components/OutlineNode";
import type { TokenView } from "./types";
import { spliceToken } from "./token-splice";

// `spliceToken` moved to the dependency-free `token-splice.ts` so worker-reachable
// data modules can import it without dragging this file's DOM helpers into the
// Workers-types compilation. Re-exported here so token-plugin consumers are
// undisturbed.
export { spliceToken };

/** True iff the caret sits within or adjacent to a token's source span — the
 *  fold/reveal rule every folding token shares (inclusive boundaries, so the
 *  caret can arrive from either edge). Replaces the copy-pasted predicate. */
export function isRevealed({ revealOffset, start, end }: TokenView): boolean {
  return revealOffset != null && revealOffset >= start && revealOffset <= end;
}

/** Verbatim-match-or-drop write-back against a node's LIVE text: resolve a
 *  mirror row to its source, read the current text, splice `oldToken`→`newToken`
 *  at the first occurrence at-or-after `sourceOffset`, and write back only if it
 *  still matches and actually changed. A no-op if the node is gone or the token
 *  was edited away — the guard that keeps a stale editor write from corrupting a
 *  since-changed bullet.
 *
 *  `sourceOffset` targets the clicked occurrence when a line repeats the same
 *  token (e.g. two identical chips); omit it to target the first (the default
 *  for tokens that can't repeat verbatim within one line). */
export function replaceTokenInNode(
  nodeId: string,
  oldToken: string,
  newToken: string,
  mutations: NodeCommands,
  sourceOffset = 0,
): void {
  if (newToken === oldToken) return;
  const index = getTreeIndex();
  const clicked = index.byId.get(nodeId);
  if (!clicked) return;
  const targetId = clicked.mirrorOf ?? nodeId;
  const current = index.byId.get(targetId)?.text;
  if (current == null) return;
  const next = spliceToken(current, oldToken, newToken, sourceOffset);
  if (next != null && next !== current) mutations.onTextChange(targetId, next);
}

/** The node id owning `el` (nearest `[data-node-id]` ancestor), or the zoom root
 *  when the element lives in the zoomed title (which has no row id), or null. The
 *  single resolution used by every Seam-B interaction handler. */
export function resolveNodeId(el: HTMLElement): string | null {
  return (
    el.closest<HTMLElement>("[data-node-id]")?.getAttribute("data-node-id") ??
    getViewRootId()
  );
}
