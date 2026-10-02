import type { FilterOperator } from "../../data/filter-query";

export const PROVENANCE_FILTER_OPERATORS: FilterOperator[] = [
  {
    key: "is",
    values: ["agent"],
    description: "Filter to agent-created nodes",
    predicate: (node) => node.origin != null,
  },
];
