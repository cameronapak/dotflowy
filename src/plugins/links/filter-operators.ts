import type { FilterOperator } from "../../data/filter-query";

import { hasLink } from "../../data/links";

export const LINK_FILTER_OPERATORS: FilterOperator[] = [
  {
    key: "has",
    values: ["link"],
    description: "Filter to nodes containing a link",
    predicate: (node) => hasLink(node.text),
  },
];
