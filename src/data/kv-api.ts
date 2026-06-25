/**
 * REST client for the generic /api/kv side-collection store (ADR 0024). Each
 * plugin side-collection (tag colors, the daily index) is one `collection`
 * namespace; `value` is the full item object, `key` is the collection's getKey.
 * Same-origin, so the Cloudflare Access cookie rides along. Consumed by the
 * createKvCollection factory (kv-collection.ts).
 */

const ENDPOINT = '/api/kv'

const url = (collection: string) =>
  `${ENDPOINT}?collection=${encodeURIComponent(collection)}`

async function send(
  collection: string,
  method: string,
  body: unknown,
): Promise<void> {
  const res = await fetch(url(collection), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${url(collection)} -> ${res.status}`)
}

/** Complete state for one collection (the query collection treats it as
 *  authoritative, so the Worker returns every owned row). */
export async function kvFetch<T>(collection: string): Promise<T[]> {
  const res = await fetch(url(collection))
  if (!res.ok) throw new Error(`GET ${url(collection)} -> ${res.status}`)
  return (await res.json()) as T[]
}

/** Upsert rows (insert + update both map here — the items are tiny). */
export const kvPut = (
  collection: string,
  rows: { key: string; value: unknown }[],
): Promise<void> => send(collection, 'POST', { rows })

export const kvDelete = (
  collection: string,
  keys: string[],
): Promise<void> => send(collection, 'DELETE', { keys })

// --- Mutation-transaction shaping --------------------------------------------
// A side-collection's onInsert/onUpdate both upsert the WHOLE value (the items
// are tiny key->value rows), and onDelete sends the keys. These map a query
// collection's mutation transaction to those payloads. The param is structural
// (just the fields read), so the concrete transaction type satisfies it without
// importing TanStack's mutation generics. Used by plugin side-collections.

type KvMutations = { mutations: readonly { key: unknown; modified?: unknown }[] }

/** Upsert rows from a transaction: `{ key, value }` per mutation. */
export const toKvRows = (t: KvMutations): { key: string; value: unknown }[] =>
  t.mutations.map((m) => ({ key: String(m.key), value: m.modified }))

/** The keys to delete from a transaction. */
export const toKvKeys = (t: KvMutations): string[] =>
  t.mutations.map((m) => String(m.key))
