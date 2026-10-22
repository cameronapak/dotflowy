// The Worker-facing operator composition. Each browser plugin registers these
// same pure values through Seam K; this entry point never imports plugin UI.
import { CORE_FILTER_OPERATORS } from "../data/core-filter-operators";
import { buildFilterOperatorMap } from "../data/filter-query";
import { HIGHLIGHT_FILTER_OPERATORS } from "./highlight/filter-operators";
import { LINK_FILTER_OPERATORS } from "./links/filter-operators";
import { PROVENANCE_FILTER_OPERATORS } from "./provenance/filter-operators";
import { TODO_FILTER_OPERATORS } from "./todos/filter-operators";

export const queryOperators = buildFilterOperatorMap([
  ...CORE_FILTER_OPERATORS,
  ...TODO_FILTER_OPERATORS,
  ...PROVENANCE_FILTER_OPERATORS,
  ...LINK_FILTER_OPERATORS,
  ...HIGHLIGHT_FILTER_OPERATORS,
]);
