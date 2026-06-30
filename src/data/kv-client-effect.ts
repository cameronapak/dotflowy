import { Data, Duration, Effect, Schedule } from 'effect'

/**
 * The Effect transport core for the /api/kv side-collections — a typed-error,
 * retrying, time-bounded kv REST client. Two shells consume it: the throwing
 * kv-api.ts (kvFetch/kvPut/kvDelete run these programs through `runPromise`, so
 * the TanStack DB mutation path keeps its throw contract) and `claimMapping`
 * (daily-index.ts), which consumes the program directly and degrades to a plain
 * value on failure. See docs/adr/0012-effect-replaces-errore.md.
 *
 * Design notes (Effect v4, beta.90):
 *  - Domain errors are tagged classes via `Data.TaggedError('Tag')<{}>`.
 *    routes on the `_tag` discriminator.
 *  - `Effect.tryPromise` lifts `fetch` into the Effect world. Its `catch` maps
 *    the untyped rejection to our `KvTransportError`.
 *  - Retry: `Schedule.both(Schedule.exponential, Schedule.recurs)` — v4 composes
 *    schedules with `both` (stop when either input stops), capping exponential
 *    backoff at a bounded attempt count.
 *  - Timeout: `Effect.timeoutOrElse({ duration, orElse })` turns a timeout into
 *    a `KvTimeoutError`, keeping the error channel typed.
 *  - Recovery: `Effect.match({ onFailure, onSuccess })` is the v4 way to
 *    convert all errors to a degraded value inside the pipeline, so
 *    `runPromise` never rejects and the caller sees only plain success.
 */

const ENDPOINT = '/api/kv'

const url = (collection: string) =>
  `${ENDPOINT}?collection=${encodeURIComponent(collection)}`

// --- Domain errors ----------------------------------------------------------

export class KvTransportError extends Data.TaggedError('KvTransportError')<{
  collection: string
  cause: unknown
}> {
  get message() {
    return `kv '${this.collection}' request failed`
  }
}

export class KvResponseError extends Data.TaggedError('KvResponseError')<{
  collection: string
  status: number
}> {
  get message() {
    return `kv '${this.collection}' -> HTTP ${this.status}`
  }
}

export class KvTimeoutError extends Data.TaggedError('KvTimeoutError')<{
  collection: string
}> {
  get message() {
    return `kv '${this.collection}' timed out`
  }
}

// --- Core fetch effect ------------------------------------------------------

/** Retry schedule: exponential backoff 100ms → cap, bounded to 4 attempts. */
const retryPolicy = Schedule.both(
  Schedule.exponential('100 millis'),
  Schedule.recurs(4),
)

interface FetchArgs {
  collection: string
  method: string
  body?: unknown
  /** Query suffix appended after `?collection=...` (e.g. `&op=claim`). */
  suffix?: string
}

/**
 * One HTTP request to /api/kv as an Effect. Retries transport failures (network
 * drop, aborted) but NOT 4xx/5xx — a 500 is a deterministic server-side failure
 * and retrying would only amplify a broken state. Failures land in the typed
 * error channel as KvTransportError | KvResponseError.
 */
function request({ collection, method, body, suffix }: FetchArgs): Effect.Effect<
  Response,
  KvTransportError | KvResponseError | KvTimeoutError
> {
  const u = suffix ? `${url(collection)}${suffix}` : url(collection)
  return Effect.tryPromise({
    // The signal comes from Effect's runtime: `Effect.timeoutOrElse` aborts it
    // on timeout, and `Effect.retry` aborts the current attempt before the next
    // one starts. Passing it to fetch cancels the in-flight request instead of
    // leaving it running with its result discarded.
    try: (signal) =>
      fetch(u, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      }),
    catch: (cause) => new KvTransportError({ collection, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(8),
      orElse: () => Effect.fail(new KvTimeoutError({ collection })),
    }),
    Effect.retry(retryPolicy),
    Effect.flatMap((res) =>
      res.ok
        ? Effect.succeed(res)
        : Effect.fail(new KvResponseError({ collection, status: res.status })),
    ),
  )
}

// --- Public API (Effect-shaped) ---------------------------------------------

/** Fetch a whole collection. */
export function kvFetchE<T>(
  collection: string,
): Effect.Effect<T[], KvTransportError | KvResponseError | KvTimeoutError> {
  return request({ collection, method: 'GET' }).pipe(
    Effect.flatMap((res) =>
      Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (cause) => new KvTransportError({ collection, cause }),
      }),
    ),
    // Validate the parsed shape before the cast: a non-array body is a contract
    // violation (server bug / proxy 200 with an HTML error page), not a success.
    Effect.flatMap((data) =>
      Array.isArray(data)
        ? Effect.succeed(data as T[])
        : Effect.fail(
            new KvTransportError({
              collection,
              cause: new Error(`expected an array, got ${typeof data}`),
            }),
          ),
    ),
  )
}

/** Upsert rows. */
export function kvPutE(
  collection: string,
  rows: { key: string; value: unknown }[],
): Effect.Effect<void, KvTransportError | KvResponseError | KvTimeoutError> {
  return request({ collection, method: 'POST', body: { rows } }).pipe(
    Effect.asVoid,
  )
}

/** Delete rows by key. */
export function kvDeleteE(
  collection: string,
  keys: string[],
): Effect.Effect<void, KvTransportError | KvResponseError | KvTimeoutError> {
  return request({
    collection,
    method: 'DELETE',
    body: { keys },
  }).pipe(Effect.asVoid)
}

/** Atomic get-or-create; returns the authoritative value. */
export function kvGetOrCreateE<T>(
  collection: string,
  key: string,
  value: T,
): Effect.Effect<
  T,
  KvTransportError | KvResponseError | KvTimeoutError
> {
  return request({
    collection,
    method: 'POST',
    body: { key, value },
    suffix: '&op=claim',
  }).pipe(
    Effect.flatMap((res) =>
      Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (cause) => new KvTransportError({ collection, cause }),
      }),
    ),
    // Validate the { value: T } envelope before unwrapping: a missing/malformed
    // value would otherwise surface as `undefined` success and deref badly at
    // the caller (claimMapping reads row.nodeId). Coerce to a transport error so
    // claimMapping's boundary degrades instead of returning garbage.
    Effect.flatMap((data) => {
      if (typeof data !== 'object' || data === null || !('value' in data)) {
        return Effect.fail(
          new KvTransportError({
            collection,
            cause: new Error(`expected { value } envelope, got ${typeof data}`),
          }),
        )
      }
      return Effect.succeed((data as { value: T }).value)
    }),
  )
}

// --- Unsafe escape hatch ----------------------------------------------------

// The throw bridge for the TanStack rollback contract lives in one place
// (shared with nodes-client-effect.ts); re-exported here so kv-api.ts and
// daily-index.ts keep importing it from the kv core.
export { runPromise } from './effect-bridge'
