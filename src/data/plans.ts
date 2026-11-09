// Plan identifiers are Better Auth's persisted subscription names.
export const FREE_NODE_LIMIT = 10000;

export type PlanName = "free" | "unlimited" | "founding";

export const PLAN_LABELS = {
  free: "Free",
  unlimited: "Unlimited",
  founding: "Founding",
} satisfies Record<PlanName, string>;
