import { type Spec, action, query } from "@wasp.sh/spec";
import {
  getNodes,
  upsertNodes,
  updateNodes,
  deleteNodes,
} from "./operations" with { type: "ref" };

// Outline sync operations (PRD Phase 2). Spread into main.wasp.ts's `spec`.
export const nodesSpec: Spec = [
  query(getNodes, { entities: ["Node"] }),
  action(upsertNodes, { entities: ["Node"] }),
  action(updateNodes, { entities: ["Node"] }),
  action(deleteNodes, { entities: ["Node"] }),
];
