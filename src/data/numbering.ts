import type { TreeIndex } from "./tree";

/** Number full ordered sibling runs, not the filtered or mounted viewport.
 * Mirrors share Kind with their source but take their number from this position. */
export function numberedOrdinals(
  index: TreeIndex,
  ids: readonly string[],
): Map<string, number> {
  const result = new Map<string, number>();
  let ordinal = 0;
  for (const id of ids) {
    const instance = index.byId.get(id);
    const content = index.byId.get(instance?.mirrorOf ?? id) ?? instance;
    if (content?.kind === "numbered") result.set(id, ++ordinal);
    else ordinal = 0;
  }
  return result;
}
