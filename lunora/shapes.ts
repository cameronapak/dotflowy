import { defineShape } from "lunorash/server";

export const wholeOutline = defineShape({
  owner: true,
  table: "nodes",
});

/** Per-user tag color rows (phase 2b). */
export const userTagColors = defineShape({
  owner: true,
  table: "tagColors",
});

/** Per-user saved filter queries (phase 2b). */
export const userSavedQueries = defineShape({
  owner: true,
  table: "savedQueries",
});

/** Per-user daily scaffold index (phase 2b — claimDailyMapping). */
export const userDailyIndex = defineShape({
  owner: true,
  table: "dailyIndex",
});

/** Temporary ADR 0061 retirement signal. Clients reload only on `retired`. */
export const userRetirementState = defineShape({
  owner: true,
  table: "retirementState",
});
