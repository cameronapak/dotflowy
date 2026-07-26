/**
 * Shared Lunora wire validators for classic `ChangeOp[]` batches (ADR 0014 /
 * ADR 0058). Browser mutators and Worker MCP both consume these — one source
 * so the trust boundary can't drift.
 */
import { v } from "lunorash/server";

/** Wire node for delta batches (classic ChangeOp value; no userId — server stamps). */
export const wireNodeArg = v.object({
  id: v.string(),
  parentId: v.string().nullable(),
  prevSiblingId: v.string().nullable(),
  text: v.string(),
  isTask: v.boolean(),
  completed: v.boolean(),
  collapsed: v.boolean(),
  bookmarkedAt: v.number().nullable(),
  mirrorOf: v.string().nullable(),
  createdAt: v.number(),
  updatedAt: v.number(),
  origin: v.string().nullable(),
  kind: v.literal("paragraph").nullable(),
});

export const changeOpArg = v.union(
  v.object({ op: v.literal("insert"), value: wireNodeArg }),
  v.object({ op: v.literal("update"), value: wireNodeArg }),
  v.object({ op: v.literal("delete"), key: v.string() }),
);
