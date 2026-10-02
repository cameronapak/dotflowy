import type { FilterOperator } from "../../data/filter-query";

export const TODO_FILTER_OPERATORS: FilterOperator[] = [
  {
    key: "is",
    values: ["complete"],
    description: "Filter to completed nodes",
    predicate: (node) => node.completed,
  },
];
