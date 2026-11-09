import type { FilterOperator } from "../../data/filter-query";

import { isQuoteText } from "../../data/quote";

/** `is:quote` (ADR 0079): quote-ness is derived from the text, so the operator
 *  tests the text source, not `kind`. Shared by the app filter and MCP search. */
export const QUOTE_FILTER_OPERATORS: FilterOperator[] = [
  {
    key: "is",
    values: ["quote"],
    description: "Filter to quotes",
    predicate: (node) => isQuoteText(node.text),
  },
];
