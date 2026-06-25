import { type Spec, action, query } from "@wasp.sh/spec";
import {
  getDailyIndex,
  upsertDailyIndex,
  deleteDailyIndexKeys,
} from "./operations" with { type: "ref" };

// Daily-index side-collection operations (PRD Phase 2).
export const dailySpec: Spec = [
  query(getDailyIndex, { entities: ["DailyIndexEntry"] }),
  action(upsertDailyIndex, { entities: ["DailyIndexEntry"] }),
  action(deleteDailyIndexKeys, { entities: ["DailyIndexEntry"] }),
];
