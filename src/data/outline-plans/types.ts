/**
 * Shared outline plan types for Lunora mutators + client optimism.
 * Converges on Dotflowy `Node` (wire-schema / schema) — `userId` is the
 * Lunora shard key only (not on the custom-DO `Node` wire type).
 */

import type { Node } from "../schema";

/** Planner node = Dotflowy Node + Lunora shard `userId`. */
export type OutlineNode = Node & { userId: string };

export type NodeKind = Node["kind"];

export type PlanPatch = {
  id: string;
  fields: Partial<
    Pick<
      OutlineNode,
      | "parentId"
      | "prevSiblingId"
      | "text"
      | "isTask"
      | "completed"
      | "collapsed"
      | "bookmarkedAt"
      | "mirrorOf"
      | "updatedAt"
      | "origin"
      | "kind"
    >
  >;
};

/** Structural plan applied identically by client optimistic apply + server mutator. */
export type OutlinePlan = {
  inserts: OutlineNode[];
  patches: PlanPatch[];
  deletes: string[];
};

export const emptyPlan = (): OutlinePlan => ({
  inserts: [],
  patches: [],
  deletes: [],
});
