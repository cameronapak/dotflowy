import { childrenOf, type TreeIndex } from "./tree";

/**
 * Deterministic hash of an answer subtree as written (ADR 0059 replace guard).
 * Covers id / parent / sibling links / text / task / completed / collapsed /
 * kind / origin — enough to detect text edits, added children, and moves.
 * Not cryptographic; collision resistance is not the goal.
 */
export function hashAnswerSubtree(
  index: TreeIndex,
  rootId: string,
): string | null {
  if (!index.byId.has(rootId)) return null;
  const parts: string[] = [];
  const walk = (id: string) => {
    const n = index.byId.get(id);
    if (!n) return;
    parts.push(
      [
        n.id,
        n.parentId ?? "",
        n.prevSiblingId ?? "",
        n.text,
        n.isTask ? "1" : "0",
        n.completed ? "1" : "0",
        n.collapsed ? "1" : "0",
        n.kind ?? "",
        n.origin ?? "",
        n.mirrorOf ?? "",
      ].join("\x1f"),
    );
    for (const child of childrenOf(index, id)) walk(child.id);
  };
  walk(rootId);
  return fnv1a(parts.join("\x1e"));
}

/** Replace only when the live subtree still matches the stored hash. */
export function shouldReplaceAnswer(
  index: TreeIndex,
  answerRootId: string,
  storedHash: string | null,
): boolean {
  if (storedHash == null) return false;
  const live = hashAnswerSubtree(index, answerRootId);
  return live != null && live === storedHash;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
