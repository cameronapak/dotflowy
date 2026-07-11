// Core-registered filter operators (ADR 0047 §4). Node KIND is a core field
// (ADR 0045), the same way `/paragraph` is a core command and fade-inheritance
// reads `completed` -- so `is:todo|bullet|paragraph` and `is:mirror` are core's
// own operators, registered beside the plugin ones in the registry. Feature
// axes (`is:complete`, `has:link`, `highlight:`, `is:agent`) live with their
// owning plugin's `filterOperators`.
//
// One operator owns the `is` KEY for the four core values; todos and provenance
// add MORE `is:` values (`complete`, `agent`) as separate operators -- legal
// because the collision guard is on (key, value) pairs, not the bare key.

import type { FilterOperator } from "./filter-query";

/**
 * `is:paragraph|todo|bullet` obey ADR 0045's render tie-break: `kind` outranks
 * `isTask`, so a node with `kind === "paragraph"` is a paragraph even if a stale
 * client also left `isTask` true. A todo is therefore a task that is NOT a
 * paragraph; a bullet is neither.
 */
export const CORE_FILTER_OPERATORS: FilterOperator[] = [
  {
    key: "is",
    values: ["todo", "bullet", "paragraph", "mirror"],
    description: "Filter by node kind (todo, bullet, paragraph, mirror)",
    predicate: (node, _index, value) => {
      switch (value) {
        case "paragraph":
          return node.kind === "paragraph";
        case "todo":
          return node.kind !== "paragraph" && node.isTask;
        case "bullet":
          return node.kind !== "paragraph" && !node.isTask;
        case "mirror":
          return node.mirrorOf != null;
        default:
          return false;
      }
    },
  },
];
