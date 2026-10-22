import { Data } from "effect";

/**
 * Domain errors for the data layer, as Effect tagged errors (`Data.TaggedError`;
 * see docs/adr/0012-effect-replaces-errore.md).
 *
 * The IO boundary with the sync API lives in api.ts / kv-api.ts, but those throws
 * are deliberately left as throws — TanStack DB's query/mutation handlers signal
 * failure by throwing (a thrown onInsert is what triggers optimistic rollback). A
 * typed error is used at the boundaries we own end-to-end, where a failure has no
 * throw-based consumer and would otherwise vanish — first-run bootstrap is the
 * one here.
 */

/** First-run import/seed was skipped because the initial sync failed: the custom-
 *  sync collection calls markReady() even when the socket can't reach the server,
 *  so it settles ready-but-empty and records the error (nodesLoadError) instead of
 *  rejecting — seeding then would have run over an unreachable outline. Carries the
 *  underlying failure as `cause`. */
export class BootstrapError extends Data.TaggedError("BootstrapError")<{
  cause: unknown;
}> {
  get message() {
    return "First-run outline bootstrap skipped: initial load failed";
  }
}
