import { schema as s } from 'jazz-tools'
import { app } from './schema'

/**
 * Server-enforced row policies for the Jazz sync backend.
 *
 * `managedByCreator()` = each node row is readable/insertable/updatable/deletable
 * only by the account that created it. That is exactly the single-user-across-
 * their-own-devices model (ADR 0016): one identity owns all its rows, every
 * device signed into that identity sees them, and nothing leaks across accounts.
 *
 * Without this file the enforcing (server) runtime defaults to DENY for every
 * operation, so data never syncs even after the schema is published. Published
 * to the server via `jazz-tools deploy <appId>` alongside schema.ts.
 *
 * The CLI loads `module.default` (or `export const permissions`); we use default.
 */
export default s.definePermissions(app, ({ policy }) => {
  policy.nodes.managedByCreator()
})
