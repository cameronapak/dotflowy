import type { FilterOperator } from "../../data/filter-query";

import { HIGHLIGHT_PATTERN, parseHighlight } from "../../data/highlight";

export const HIGHLIGHT_FILTER_OPERATORS: FilterOperator[] = [
  {
    key: "highlight",
    values: ["red", "orange", "yellow", "green", "blue", "purple"],
    bare: true,
    swatch: true,
    description: "Filter to highlighted nodes (optionally by color)",
    predicate: (node, _index, value) => {
      if (!node.text.includes("==")) return false;
      for (const match of node.text.matchAll(
        new RegExp(HIGHLIGHT_PATTERN, "gu"),
      )) {
        if (value === null || parseHighlight(match[0]).color === value)
          return true;
      }
      return false;
    },
  },
];
