import { z } from 'zod'

/**
 * Node: a single bullet in the outline.
 *
 * Storage strategy: flat list in a single TanStack DB collection.
 * The tree is reconstructed in memory at read time from parentId pointers.
 *
 * Why flat, not nested? Flat maps cleanly onto a row-based sync backend
 * (today the per-user Durable Object's `nodes` table), keeps moves/
 * repagination cheap, and means we never have to deep-merge trees on
 * every keystroke. The outline render is a simple recursive walk over an index.
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
  // Whether this bullet renders a checkbox (a "task") vs a plain bullet.
  // Purely a display choice, independent of `completed`. See ADR 0001.
  isTask: z.boolean(),
  // Done-status. Applies to any bullet, task or not. Toggled by Cmd+Enter.
  completed: z.boolean(),
  collapsed: z.boolean(),
  // Bookmark pointer. `null` = not bookmarked; a timestamp = bookmarked, and
  // also the sort key for the bookmarks list (newest pinned first). A nullable
  // timestamp beats a boolean: it carries both "is it pinned?" and "in what
  // order?" in one field. See ADR 0011.
  bookmarkedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type Node = z.infer<typeof nodeSchema>
