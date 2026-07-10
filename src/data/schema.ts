import { Schema } from "effect";

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
 * Schema language: Effect `Schema` (ADR 0012 made Effect the error/validation
 * model; the Worker trust boundary in worker/wire.ts already speaks it). No
 * transforms and no optional fields, so the schema's Encoded and Type are the
 * same all-required shape -- which is what keeps TanStack DB's schema-typed
 * collection overload (WritableObjectDeep) happy. We always construct complete
 * nodes via makeNode(), so there's nothing to default.
 */
export const nodeSchema = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  prevSiblingId: Schema.NullOr(Schema.String),
  text: Schema.String,
  // Whether this bullet renders a checkbox (a "task") vs a plain bullet.
  // Purely a display choice, independent of `completed`. See ADR 0001.
  isTask: Schema.Boolean,
  // Done-status. Applies to any bullet, task or not. Toggled by Cmd+Enter.
  completed: Schema.Boolean,
  collapsed: Schema.Boolean,
  // Bookmark pointer. `null` = not bookmarked; a timestamp = bookmarked, and
  // also the sort key for the bookmarks list (newest pinned first). A nullable
  // timestamp beats a boolean: it carries both "is it pinned?" and "in what
  // order?" in one field. See ADR 0011.
  bookmarkedAt: Schema.NullOr(Schema.Number),
  // Mirror pointer (ADR 0022). `null` = this node is its own source (the normal
  // case); a node id = this node is a *mirror* that windows that source's content
  // and children. The content id is `mirrorOf ?? id`. Required + nullable, no
  // default (ADR 0003) -- makeNode() sets it to null. Stage 0 ships this field
  // dark: nothing reads it yet.
  mirrorOf: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  // Provenance (write-once). `null` = created by the human in the editor (every
  // node born from a keystroke, and every row that predates this field); a
  // non-null string = the harness name of the agent that created it via the MCP
  // server (e.g. "Claude"). Stamped server-side at the one MCP write choke point
  // (worker/outline-ops.ts newNode); the client always sets it to null via
  // makeNode. Required + nullable, no default (ADR 0003). Read only for display
  // (the provenance plugin's origin marker) -- never a semantic branch.
  origin: Schema.NullOr(Schema.String),
});

export type Node = Schema.Schema.Type<typeof nodeSchema>;
