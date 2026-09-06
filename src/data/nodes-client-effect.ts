import { Data, Duration, Effect, Schedule } from "effect";

import type { ChangeOp } from "./realtime";
import type { Node } from "./schema";

/**
 * The Effect transport core for the /api/nodes Worker (which routes to the
 * user's Durable Object) — a typed-error, retrying, time-bounded REST client,
 * the outline twin of kv-client-effect.ts. `api.ts` is the throwing shell over
 * it (so the TanStack DB mutation path keeps its throw-on-failure rollback
 * contract); see docs/adr/0021-effect-first-one-schema-language.md and the
 * conversion plan in .scratch/effect-tightening/.
 *
 * Why this exists: the primary data path (the outline itself) used to be raw
 * `fetch` with none of the resilience the kv side-collections already had. This
 * brings parity — retry (exponential backoff), 8s timeout, typed errors, and
 * response-shape validation on the `{ seq }` batch envelope.
 *
 * Design notes (Effect v4) — mirrors kv-client-effect.ts deliberately:
 *  - Domain errors are tagged classes via `Data.TaggedError`.
 *  - `Effect.tryPromise` lifts `fetch`; its `catch` maps the rejection to
 *    `NodesTransportError`.
 *  - Retry wraps the fetch (+ timeout), so only TRANSPORT failures (the fetch
 *    promise rejects: network drop, abort) retry. A received response — even a
 *    5xx — resolves the fetch, so the `res.ok` check sits AFTER `retry` and is
 *    NOT retried (a 500 is deterministic; retrying amplifies a broken write).
 *    Retrying the committed-but-lost-ack case is safe: every DO op is an
 *    absolute upsert/delete keyed by id (worker/outline-do.ts putNode/
 *    deleteNodeRow), so re-applying a batch is idempotent on state.
 *  - Timeout: `Effect.timeoutOrElse` turns a stall into a typed `NodesTimeoutError`.
 */

const ENDPOINT = "/api/nodes";

/** A JSON-parsed value of unchecked shape — the domain `res.json()` produces. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Request bodies /api/nodes accepts, one shape per verb. */
type NodesRequestBody =
  | { nodes: Node[] }
  | { updates: { id: string; changes: Partial<Node> }[] }
  | { ids: string[] }
  | { ops: ChangeOp[] };

/** Type-guard predicate for the `{ seq }` batch envelope. */
const hasSeqField = (data: JsonValue | undefined): data is { seq: JsonValue } =>
  typeof data === "object" && data !== null && "seq" in data;

/** A DO frame seq is a monotonic non-negative safe integer. */
const isSeq = (v: JsonValue | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** typeof name for a JSON-parsed value (null and array report "object"). */
const jsonTypeOf = (value: JsonValue | undefined): string => {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag === "Null" || tag === "Array") return "object";
  return tag.toLowerCase();
};

// --- Domain errors ----------------------------------------------------------

export class NodesTransportError extends Data.TaggedError(
  "NodesTransportError",
)<{
  cause: unknown;
}> {
  get message() {
    return "nodes request failed";
  }
}

export class NodesResponseError extends Data.TaggedError("NodesResponseError")<{
  status: number;
}> {
  get message() {
    return `nodes -> HTTP ${this.status}`;
  }
}

export class NodesTimeoutError extends Data.TaggedError(
  "NodesTimeoutError",
)<{}> {
  get message() {
    return "nodes request timed out";
  }
}

/**
 * The write was refused because a free-tier outline is at its node ceiling and
 * this batch would grow it past the cap (#170 — the Worker's 403 `node_limit`
 * body). A distinct error, not a generic `NodesResponseError`, so the structural
 * funnel can surface a dedicated upgrade toast (structural.ts) before the
 * optimistic overlay rolls back. `limit` is the ceiling the server reported.
 */
export class NodesLimitError extends Data.TaggedError("NodesLimitError")<{
  limit: number;
}> {
  get message() {
    return `nodes -> node limit (${this.limit})`;
  }
}

/** Was this the free-tier node-ceiling refusal (#170)? The cap has its own
 *  upgrade toast (structural.ts), so failure funnels use this to SKIP a generic
 *  "couldn't save/open" notice and avoid double-toasting the same event. */
export function isNodesLimitError(cause: unknown): cause is NodesLimitError {
  return cause instanceof NodesLimitError;
}

export type NodesError =
  | NodesTransportError
  | NodesResponseError
  | NodesTimeoutError
  | NodesLimitError;

// --- Core request effect ----------------------------------------------------

/** Retry schedule: exponential backoff 100ms → cap, bounded to 4 attempts. */
const retryPolicy = Schedule.both(
  Schedule.exponential("100 millis"),
  Schedule.recurs(4),
);

/**
 * One HTTP request to /api/nodes as an Effect. Retries transport failures only
 * (see the module note); a non-2xx response lands as `NodesResponseError`, a
 * stall as `NodesTimeoutError`.
 */
function request(
  method: string,
  body: NodesRequestBody,
): Effect.Effect<Response, NodesError> {
  return Effect.tryPromise({
    // The signal comes from Effect's runtime: `timeoutOrElse` aborts it on
    // timeout and `retry` aborts the current attempt before the next, so a
    // superseded request is cancelled instead of left running.
    try: (signal) =>
      fetch(ENDPOINT, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      }),
    catch: (cause) => new NodesTransportError({ cause }),
  }).pipe(
    // Retry transport failures (with backoff), THEN bound the whole sequence by
    // one 8s budget. Timeout OUTSIDE retry on purpose: if it wrapped each
    // attempt, a wedged endpoint would get 8s PER attempt (~40s across 5) and
    // hold the writeSem permit that long; outside, the entire request — every
    // retry included — can't exceed 8s, and the timeout itself isn't retried.
    Effect.retry(retryPolicy),
    Effect.timeoutOrElse({
      duration: Duration.seconds(8),
      orElse: () => Effect.fail(new NodesTimeoutError()),
    }),
    Effect.flatMap(classifyResponse),
  );
}

/**
 * Map a received (already non-retried) response to success or a typed failure.
 * A 403 on /api/nodes is the free-tier node ceiling (#170): read the
 * `{ error: "node_limit", limit }` body to classify it apart from a generic
 * failure so the caller can surface an upgrade prompt. Any other non-2xx (incl.
 * a 403 without that body) stays a plain `NodesResponseError`.
 */
function classifyResponse(res: Response): Effect.Effect<Response, NodesError> {
  if (res.ok) return Effect.succeed(res);
  if (res.status === 403) {
    return Effect.tryPromise({
      // SAFETY: widening Promise<any> to Promise<JsonValue>; the body is validated by isNodeLimitBody below.
      try: () => res.json() as Promise<JsonValue>,
      catch: () => new NodesResponseError({ status: 403 }),
    }).pipe(
      Effect.flatMap(
        (body): Effect.Effect<never, NodesError> =>
          isNodeLimitBody(body)
            ? Effect.fail(new NodesLimitError({ limit: body.limit }))
            : Effect.fail(new NodesResponseError({ status: 403 })),
      ),
    );
  }
  return Effect.fail(new NodesResponseError({ status: res.status }));
}

/** Narrow the Worker's 403 body to the node-limit shape. */
function isNodeLimitBody(
  body: JsonValue,
): body is { error: string; limit: number } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return false;
  // SAFETY: body is narrowed to a non-array JSON object by the checks above; each field is then checked before use.
  const record = body as { error?: JsonValue; limit?: JsonValue };
  return record.error === "node_limit" && typeof record.limit === "number";
}

// --- Public API (Effect-shaped) ---------------------------------------------

/** Seed/create nodes (first-run + non-structural creates). */
export const createNodesE = (nodes: Node[]): Effect.Effect<void, NodesError> =>
  request("POST", { nodes }).pipe(Effect.asVoid);

/** Field-edit PATCH (text, completed, …) — one or more `{ id, changes }`. */
export const updateNodesE = (
  updates: { id: string; changes: Partial<Node> }[],
): Effect.Effect<void, NodesError> =>
  request("PATCH", { updates }).pipe(Effect.asVoid);

/** Delete nodes by id. */
export const deleteNodesE = (ids: string[]): Effect.Effect<void, NodesError> =>
  request("DELETE", { ids }).pipe(Effect.asVoid);

/**
 * Persist a structural batch and return the committed frame's seq. Validates
 * the `{ seq: number }` envelope before returning: a non-object / missing /
 * non-numeric `seq` (a proxy 200 with an HTML body, a server bug) is a contract
 * violation, coerced to a transport error — NOT an `undefined` success that
 * would later make `waitForSeq(undefined)` hang to its timeout.
 */
export const sendBatchE = (
  ops: ChangeOp[],
): Effect.Effect<{ seq: number }, NodesError> =>
  request("POST", { ops }).pipe(
    Effect.flatMap((res) =>
      Effect.tryPromise({
        // SAFETY: widening Promise<any> to Promise<JsonValue>; the seq field is validated immediately below.
        try: () => res.json() as Promise<JsonValue>,
        catch: (cause) => new NodesTransportError({ cause }),
      }),
    ),
    Effect.flatMap((data) => {
      // A DO frame seq is a monotonic non-negative integer counter, so reject
      // anything that isn't one — a typeof-string check alone would also admit
      // NaN/Infinity/negatives/floats, and waitForSeqE does a numeric `>=`
      // compare on this (a NaN would hang to its timeout, a bogus value resolve
      // it instantly). JSON can't even carry NaN/Infinity, so this only bites a
      // server bug, but the guard is free.
      const seq = hasSeqField(data) ? data.seq : undefined;
      return isSeq(seq)
        ? Effect.succeed({ seq })
        : Effect.fail(
            new NodesTransportError({
              cause: new Error(
                `expected { seq: non-negative int }, got ${jsonTypeOf(data)}`,
              ),
            }),
          );
    }),
  );

// --- Unsafe escape hatch ----------------------------------------------------

// The throw bridge for the TanStack rollback contract lives in one place
// (shared with kv-client-effect.ts); re-exported here so api.ts/structural.ts/
// collection.ts keep importing it from the nodes core.
export { runPromise } from "./effect-bridge";
