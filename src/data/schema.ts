import { z } from 'zod'

/**
 * Node: a single bullet in the outline.
 *
 * Storage strategy: flat list in a single TanStack DB collection.
 * The tree is reconstructed in memory at read time from parentId pointers.
 *
 * Why flat, not nested? Flat maps cleanly onto a sync backend later
 * (ElectricSQL / Postgres rows), keeps moves/repagination cheap, and
 * means we never have to deep-merge trees on every keystroke. The
 * outline render is a simple recursive walk over an index.
 *
 * Ordering: prevSiblingId forms a linked list within each parent.
 * This is the Workflowy/Notion approach: inserting between two
 * siblings is O(1), no renumbering. Reordering is relinking pointers.
 *
 * Note: no zod .default() values. Defaults make zod's inferred *input*
 * type optional, which collides with TanStack DB's WritableObjectDeep
 * handling in the schema-typed collection overload. We always
 * construct complete nodes via makeNode(), so defaults buy us nothing.
 */
export const nodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  prevSiblingId: z.string().nullable(),
  text: z.string(),
  // Whether this bullet is a task (renders a checkbox) vs a plain bullet.
  // `completed` only carries meaning when isTask is true. Kept as a flat
  // boolean so it maps to a single column on the future sync backend.
  isTask: z.boolean(),
  completed: z.boolean(),
  collapsed: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type Node = z.infer<typeof nodeSchema>
