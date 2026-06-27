import { Data, Duration, Effect, Schedule } from 'effect'

/**
 * Effect v4 pilot — a typed-error, retrying, time-bounded variant of the kv
 * REST client. Lives alongside the throwing kv-api.ts; nothing imports it yet.
 * See `claimMapping` (daily-index.ts) for the intended call site: it's the one
 * boundary that already degrades to an errore-style value on failure, so it's
 * the natural place to prove Effect's typed-error + retry ergonomics against
 * real I/O without touching the throw-based TanStack DB mutation path.
 *
 * Design notes (Effect v4, beta.90):
 *  - Domain errors are tagged classes via `Data.Error`. `Effect.catchTag`
 *    routes on the `_tag` discriminator.
 *  - `Effect.tryPromise` lifts `fetch` into the Effect world. Its `catch` maps
 *    the untyped rejection to our `KvTransportError`.
 *  - Retry: `Schedule.both(Schedule.exponential, Schedule.recurs)` — v4 composes
 *    schedules with `both` (stop when either input stops), capping exponential
 *    backoff at a bounded attempt count.
 *  - Timeout: `Effect.timeoutOrElse({ duration, orElse })` turns a timeout into
 *    a `KvTimeoutError`, keeping the error channel typed.
 */

const ENDPOINT = '/api/kv'

const url = (collection: string) =>
  `${ENDPOINT}?collection=${encodeURIComponent(collection)}`

// --- Domain errors ----------------------------------------------------------

export class KvTransportError extends Data.Error<{ collection: string; cause: unknown }> {
  static readonly _tag = 'KvTransportError' as const
  get message() {
    return `kv '${this.collection}' request failed`
  }
}

export class KvResponseError extends Data.Error<{
  collection: string
  status: number
}> {
  static readonly _tag = 'KvResponseError' as const
  get message() {
    return `kv '${this.collection}' -> HTTP ${this.status}`
  }
}

export class KvTimeoutError extends Data.Error<{ collection: string }> {
  static readonly _tag = 'KvTimeoutError' as const
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
    try: () =>
      fetch(u, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
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
        try: () => res.json() as Promise<T[]>,
        catch: (cause) => new KvTransportError({ collection, cause }),
      }),
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
        try: () => res.json() as Promise<{ value: T }>,
        catch: (cause) => new KvTransportError({ collection, cause }),
      }),
    ),
    Effect.map((r) => r.value),
  )
}

// --- Unsafe escape hatch ----------------------------------------------------

/**
 * Run an Effect kv program and convert its typed error into a thrown Error, so a
 * caller that still speaks the throw-based contract (TanStack DB mutation
 * handlers, which signal failure by throwing to trigger optimistic rollback)
 * can adopt the Effect pipeline without a wider rewrite.
 */
export function runPromise<T, E>(
  effect: Effect.Effect<T, E>,
): Promise<T> {
  return Effect.runPromise(
    effect.pipe(
      Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
    ),
  )
}
