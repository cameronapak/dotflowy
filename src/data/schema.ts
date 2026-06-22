import { schema as s } from 'jazz-tools'

/**
 * Node: a single bullet in the outline.
 *
 * Storage strategy: flat list in a single Jazz table. The tree is
 * reconstructed in memory at read time from parentId pointers.
 *
 * Why flat, not nested? Flat maps cleanly onto the sync backend, keeps
 * moves/repagination cheap, and means we never have to deep-merge trees on
 * every keystroke. The outline render is a simple recursive walk over an index.
 *
 * Ordering: prevSiblingId forms a linked list within each parent (Workflowy
 * approach: inserting between two siblings is O(1)). Replacing this with a
 * fractional sortKey is the next data-model step (see PLAN.md item 2); it is
 * deliberately out of scope for the TanStack DB -> Jazz backend swap.
 *
 * Backend note: Jazz tables store every column with last-write-wins per field
 * by default, which is exactly the conflict model the sync design settled on
 * (single user across their own devices). `parentId` / `prevSiblingId` are plain
 * TEXT columns, NOT Jazz ref columns -- they are self-referential and we resolve
 * order ourselves in buildTreeIndex, so we don't want Jazz's relation machinery.
 */
export const jazzSchema = s.defineSchema({
  nodes: s.table({
    parentId: s.string().optional(),
    prevSiblingId: s.string().optional(),
    text: s.string(),
    // Whether this bullet renders a checkbox (a "task") vs a plain bullet.
    // Purely a display choice, independent of `completed`. See docs/adr/0001.
    isTask: s.boolean(),
    // Done-status. Applies to any bullet, task or not. Toggled by Cmd+Enter.
    completed: s.boolean(),
    collapsed: s.boolean(),
    // Bookmark pointer. `null` = not bookmarked; a timestamp = bookmarked, and
    // also the sort key for the bookmarks list (newest pinned first). See ADR 0011.
    //
    // Timestamps are `float` (REAL / f64), NOT `int`: Jazz's `int` is a 32-bit
    // integer and JS millisecond epoch values (Date.now() ~= 1.78e12) overflow
    // it. f64 represents integers exactly up to 2^53, which covers epoch-ms for
    // ~285,000 years, so these stay plain `number`s end to end.
    bookmarkedAt: s.float().optional(),
    createdAt: s.float(),
    updatedAt: s.float(),
  }),
})

/**
 * The typed Jazz app. Carries the compiled schema; every query/table proxy
 * (`app.nodes`, `app.nodes.where(...)`) hangs off it. `getDb()` in jazz.ts reads
 * and writes through these proxies.
 */
export const app = s.defineApp(jazzSchema)

/**
 * The outline node, exactly as the rest of the app consumes it. Kept as an
 * explicit interface (rather than `s.RowOf<typeof app.nodes>`) so the data layer
 * isn't coupled to Jazz's generics and `makeNode()` can return a plain object.
 * Optional Jazz columns surface as `T | null`, matching these field types.
 */
export interface Node {
  id: string
  parentId: string | null
  prevSiblingId: string | null
  text: string
  isTask: boolean
  completed: boolean
  collapsed: boolean
  bookmarkedAt: number | null
  createdAt: number
  updatedAt: number
}
