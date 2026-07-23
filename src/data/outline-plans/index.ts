export type { OutlineNode, OutlinePlan, PlanPatch, NodeKind } from "./types";
export { emptyPlan } from "./types";

export { orderSiblings, chainDisagreements } from "../sibling-chain";
export type { ChainDisagreement } from "../sibling-chain";

export { buildTreeIndex, childrenOf, makeNode, parentKeyOf } from "../tree";
export type { TreeIndex } from "../tree";

export {
  makeOutlineNode,
  planInsertSibling,
  planInsertChildAtStart,
  planIndent,
  planOutdent,
  planRemoveNode,
  planRemoveMany,
  planSetText,
  planSetCompleted,
  planSetCollapsed,
  planSetIsTask,
  planSetKind,
  planSetBookmarkedAt,
  planMoveNode,
  planMoveMany,
  planIndentMany,
  planOutdentMany,
  planMaterializeDailyNodes,
  planSplitNode,
  sameNodeFields,
  planRestoreNodes,
  planMirrorNode,
  applyPlan,
} from "./planners";

export {
  rowToNode,
  docToNode,
  nodeToDocFields,
  nodeToRow,
  nodeToInsertFields,
} from "./map-node";
export type { NodeDocLike } from "./map-node";

export {
  DEMO_SEED_TEXTS,
  DEMO_SEED_IDS,
  shouldSeedOutline,
  planSeedIfEmpty,
  seedEmptyOutline,
} from "./seed";
export type { SeedIfEmptyArgs, SeedIfEmptyFn } from "./seed";
