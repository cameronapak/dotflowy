import * as errore from 'errore'

/**
 * Domain errors for the data layer (errore.org convention).
 *
 * The IO boundary with D1 lives in api.ts, but those throws are deliberately
 * left as throws — TanStack DB's query/mutation handlers signal failure by
 * throwing (a thrown onInsert is what triggers optimistic rollback). errore is
 * applied at the boundaries we own end-to-end, where a failure has no
 * throw-based consumer and would otherwise vanish — first-run bootstrap being
 * the first.
 */

/** First-run import/seed was skipped because the initial D1 load failed (the
 *  query settled in error, so seeding would have run over an unreachable
 *  outline). Carries the underlying query error as `cause`. */
export class BootstrapError extends errore.createTaggedError({
  name: 'BootstrapError',
  message: 'First-run outline bootstrap skipped: initial load failed',
}) {}
