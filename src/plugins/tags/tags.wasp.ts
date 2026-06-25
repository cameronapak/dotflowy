import { type Spec, action, query } from "@wasp.sh/spec";
import {
  getTagColors,
  upsertTagColors,
  deleteTagColors,
} from "./operations" with { type: "ref" };

// Tag-color side-collection operations (PRD Phase 2).
export const tagsSpec: Spec = [
  query(getTagColors, { entities: ["TagColor"] }),
  action(upsertTagColors, { entities: ["TagColor"] }),
  action(deleteTagColors, { entities: ["TagColor"] }),
];
