/**
 * Pure outline node used by planners. `id` maps to Lunora `_id` at the
 * mutator boundary via `clientId` on insert.
 */
export type OutlineNode = {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: "paragraph" | null;
  userId: string;
};

export type NodeKind = "paragraph" | null;

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
