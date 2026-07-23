/**
 * Spike re-exports shared planners from repo `src/data/outline-plans/`.
 * Bridge stays local (ADR 0004 handoff UI seam).
 *
 * Import path: Vite/vitest alias `@dotflowy/outline-plans` →
 * `../../../src/data/outline-plans` (see vite.config.ts / vitest.config.ts).
 */

export type {
  OutlineNode,
  OutlinePlan,
  PlanPatch,
  NodeKind,
  NodeDocLike,
  SeedIfEmptyArgs,
  SeedIfEmptyFn,
  TreeIndex,
  ChainDisagreement,
} from "@dotflowy/outline-plans";

export {
  emptyPlan,
  orderSiblings,
  chainDisagreements,
  buildTreeIndex,
  childrenOf,
  makeNode,
  makeOutlineNode,
  parentKeyOf,
  planInsertSibling,
  planIndent,
  planOutdent,
  planRemoveNode,
  planSetText,
  applyPlan,
  rowToNode,
  docToNode,
  nodeToDocFields,
  nodeToRow,
  nodeToInsertFields,
  DEMO_SEED_TEXTS,
  DEMO_SEED_IDS,
  shouldSeedOutline,
  planSeedIfEmpty,
  seedEmptyOutline,
} from "@dotflowy/outline-plans";

export {
  rowsToOutlineNodes,
  bridgeTreeIndex,
  bridgeOrderedChildren,
} from "./lunora-bridge.js";
