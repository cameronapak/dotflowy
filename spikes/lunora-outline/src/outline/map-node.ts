import type { OutlineNode } from "./types.js";

/**
 * Loose Lunora / TanStack row shape. Codegen Doc types currently erase
 * `.nullable()`, so boundaries cast through this helper once.
 */
export type NodeDocLike = {
  _id: string;
  parentId?: unknown;
  prevSiblingId?: unknown;
  text?: unknown;
  isTask?: unknown;
  completed?: unknown;
  collapsed?: unknown;
  bookmarkedAt?: unknown;
  mirrorOf?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  origin?: unknown;
  kind?: unknown;
  userId?: unknown;
};

/** Shared Doc/row → planner node. Use at every Lunora↔outline boundary. */
export function rowToNode(doc: NodeDocLike): OutlineNode {
  return {
    id: doc._id,
    parentId: (doc.parentId as string | null) ?? null,
    prevSiblingId: (doc.prevSiblingId as string | null) ?? null,
    text: String(doc.text ?? ""),
    isTask: Boolean(doc.isTask),
    completed: Boolean(doc.completed),
    collapsed: Boolean(doc.collapsed),
    bookmarkedAt: (doc.bookmarkedAt as number | null) ?? null,
    mirrorOf: (doc.mirrorOf as string | null) ?? null,
    createdAt: Number(doc.createdAt ?? 0),
    updatedAt: Number(doc.updatedAt ?? 0),
    origin: (doc.origin as string | null) ?? null,
    kind: doc.kind === "paragraph" ? "paragraph" : null,
    userId: String(doc.userId ?? ""),
  };
}

/** Alias for server mutator docs (`_id` rows from `ctx.db.query`). */
export const docToNode = rowToNode;

/**
 * Planner node → outbound Doc/row fields (one helper for optimistic insert +
 * tests). `_creationTime` mirrors Lunora’s system field for TanStack rows.
 */
export function nodeToDocFields(
  node: OutlineNode,
): Omit<NodeDocLike, "_id"> & { _id: string; _creationTime: number } {
  return {
    _id: node.id,
    _creationTime: node.createdAt,
    parentId: node.parentId,
    prevSiblingId: node.prevSiblingId,
    text: node.text,
    isTask: node.isTask,
    completed: node.completed,
    collapsed: node.collapsed,
    bookmarkedAt: node.bookmarkedAt,
    mirrorOf: node.mirrorOf,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    origin: node.origin,
    kind: node.kind,
    userId: node.userId,
  };
}

/** Alias — same outbound map (was a near-dup in outline-store). */
export const nodeToRow = nodeToDocFields;

/** Server insert payload: Doc fields without `_id` / `_creationTime`. */
export function nodeToInsertFields(
  node: OutlineNode,
): Omit<ReturnType<typeof nodeToDocFields>, "_id" | "_creationTime"> {
  const { _id: _, _creationTime: __, ...fields } = nodeToDocFields(node);
  return fields;
}
