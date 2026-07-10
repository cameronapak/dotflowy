/**
 * Throw-based client for the generic /api/kv side-collection store (ADR 0008).
 * Each plugin side-collection (tag colors, the daily index) is one `collection`
 * namespace; `value` is the full item object, `key` is the collection's getKey.
 *
 * These are thin SHELLS over the Effect transport core in kv-client-effect.ts:
 * each runs the matching Effect program through `runPromise`, so every kv write
 * inherits the core's retry (exponential backoff), 8s timeout, typed errors, and
 * response-shape validation — instead of the bespoke bare-fetch they used to be.
 *
 * They keep THROWING on failure on purpose: TanStack DB mutation handlers signal
 * failure by throwing (a throw triggers optimistic rollback), so the consumers
 * (tag-colors.ts, daily-index.ts onInsert/onUpdate/onDelete) need a rejecting
 * promise, not an Effect value. The throw is now Effect-backed, not hand-rolled.
 *
 * Same-origin, so the Better Auth session cookie rides along automatically. See
 * AGENTS.md "Error Handling" for the errore -> Effect direction.
 */

import { kvDeleteE, kvFetchE, kvPutE, runPromise } from "./kv-client-effect";

/** Complete state for one collection (the query collection treats it as
 *  authoritative, so the Worker returns every owned row). */
export const kvFetch = <T>(collection: string): Promise<T[]> =>
  runPromise(kvFetchE<T>(collection));

/** Upsert rows (insert + update both map here — the items are tiny). */
export const kvPut = (
  collection: string,
  rows: { key: string; value: unknown }[],
): Promise<void> => runPromise(kvPutE(collection, rows));

export const kvDelete = (collection: string, keys: string[]): Promise<void> =>
  runPromise(kvDeleteE(collection, keys));

// --- Mutation-transaction shaping --------------------------------------------
// A side-collection's onInsert/onUpdate both upsert the WHOLE value (the items
// are tiny key->value rows), and onDelete sends the keys. These map a query
// collection's mutation transaction to those payloads. The param is structural
// (just the fields read), so the concrete transaction type satisfies it without
// importing TanStack's mutation generics. Used by tag-colors.ts / daily-index.ts.

type KvMutations = {
  mutations: readonly { key: unknown; modified?: unknown }[];
};

/** Upsert rows from a transaction: `{ key, value }` per mutation. */
export const toKvRows = (t: KvMutations): { key: string; value: unknown }[] =>
  t.mutations.map((m) => ({ key: String(m.key), value: m.modified }));

/** The keys to delete from a transaction. */
export const toKvKeys = (t: KvMutations): string[] =>
  t.mutations.map((m) => String(m.key));
