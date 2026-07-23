/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Worker: serves the static SPA (via the ASSETS binding) and the
 * sync API — /api/nodes (the outline) and /api/kv (plugin side-collections).
 * Each request is routed to the current user's Durable Object (UserOutlineDO),
 * whose colocated SQLite holds that user's entire outline. See docs/adr/0008-sync-via-a-per-user-durable-object.md.
 *
 * Identity = Better Auth (worker/auth.ts), email + password signup gated by an
 * invite code during alpha (INVITE_CODES), sessions in D1. The static shell is
 * PUBLIC (the login screen must load); only the data API (/api/nodes, /api/kv)
 * is gated, by a valid session. /api/waitlist is the one other public route —
 * it collects emails from people who want an invite. The DO
 * routing key is the session's stable `user.id` — a DO name is *permanent*, so
 * it must never be an email or any value that can change (see resolveUserId).
 *
 * D1 holds (1) Better Auth's identity tables (user/session/account), and (2) the
 * pre-DO legacy outline rows, kept only as the source for the one-time,
 * non-destructive import into the owner's DO (`ensureSeededE`).
 *
 * Error handling: typed domain errors flow through Effect's error channel and
 * are mapped to HTTP status codes in one place at the outer boundary. Unexpected
 * failures (DO errors, network errors) become Effect *defects* — they bypass the
 * typed channel and are caught by the `runPromise().catch()` fallback, giving
 * unambiguous 500s without collapsing known validation errors into the same bucket.
 */

import * as Sentry from "@sentry/cloudflare";
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import { Data, Effect, Schema } from "effect";

import type { Node } from "./wire";

import {
  pendingAnnounceEmails,
  sendAnnouncements,
  type AnnounceBatchResult,
} from "./announce";
import { createAuth } from "./auth";
import {
  OutlineSnapshotSchema,
  SNAPSHOT_VERSION,
  backupKey,
  backupKeyForDate,
  backupPrefix,
  backupTargets,
  isBackupDateKey,
} from "./backup";
import {
  OWNER_DO_ID,
  isAdminSession,
  isPlausibleEmail,
  isSignupOpen,
  resolveUserId,
} from "./identity";
import {
  mintInvites,
  normalizeEmail,
  pendingWaitlistEmails,
  type InviteBatchResult,
} from "./invites";
import { lunoraApp, ShardDO, type LunoraEnv } from "./lunora-app";
import { handleMcp, mcpCorsPreflight } from "./mcp";
import { UserOutlineDO as BaseUserOutlineDO } from "./outline-do";
import { FREE_NODE_LIMIT, getPlan, nodeLimitForPlan } from "./plan";
import { resolveRestorePoint } from "./restore";
import { workerSentryOptions } from "./sentry";
import { isHttpUrlString, unfurlTitleE } from "./unfurl";
import {
  AdminAnnouncePostBody,
  AdminInvitePostBody,
  AdminRestorePostBody,
  AdminSnapshotRestorePostBody,
  KvClaimBody,
  KvDeleteBody,
  KvUpsertBody,
  NodesDeleteBody,
  NodesPatchBody,
  NodesPostBody,
  WaitlistPostBody,
} from "./wire";

// Re-export the DO class so the Workers runtime can instantiate it (the
// wrangler `durable_objects` binding resolves `UserOutlineDO` from the entry).
// Wrap the EXPORT with Sentry (#227) — instrumenting the class alone drops
// events in v10; the wrapper must be what wrangler resolves by name. The type
// alias preserves the `UserOutlineDO` type name the bindings/stubs below use.
export const UserOutlineDO = Sentry.instrumentDurableObjectWithSentry(
  workerSentryOptions,
  BaseUserOutlineDO,
);
type UserOutlineDO = BaseUserOutlineDO;

// Lunora ShardDO (ADR 0055) — re-export for wrangler `SHARD` binding.
// TEMP: not Sentry-wrapped — Lunora's ShardDOState.sql typing doesn't satisfy
// Sentry's DurableObjectState constraint (document in HANDOFF).
export { ShardDO };

interface Env extends LunoraEnv {
  /** Public Sentry DSN (a wrangler.jsonc var, not a secret; it ships in the
   *  client bundle too). Unset => error monitoring is dormant. See worker/
   *  sentry.ts (ticket #227, decided in #156). */
  SENTRY_DSN?: string;
  DB: D1Database;
  ASSETS: Fetcher;
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>;
  /** The owner's Better Auth `user.id`. When set, that one account routes to
   *  the constant 'default' DO (where the pre-auth outline already lives), so
   *  the owner's existing data carries over with zero copy. Everyone else
   *  routes to their own `user.id`. See resolveUserId. */
  OWNER_USER_ID?: string;
  /** Owner key the legacy D1 rows are scoped under, read once during the
   *  one-time import into the owner's DO. Defaults to 'owner'. */
  APP_OWNER?: string;
  /** Off-site outline backups (#221): the daily cron sweep writes one JSON
   *  snapshot per user DO here (`backups/<doName>/<YYYY-MM-DD>.json`); the
   *  admin restore-snapshot route reads them back. Lifecycle expiry is set on
   *  the bucket itself — see docs/runbooks/offsite-backup-r2.md. */
  BACKUPS: R2Bucket;
  /** Per-user rate limiter for the link-title unfurl endpoint (ADR 0016). */
  UNFURL_LIMIT: RateLimit;
  /** Per-IP rate limiter for the public alpha-waitlist endpoint. */
  WAITLIST_LIMIT: RateLimit;
  /** Comma-separated Better Auth `user.id`s allowed on admin surfaces — the
   *  PINNED admin identity (#232). When set, this is the sole admin check and
   *  ADMIN_EMAILS is ignored, closing the register-the-admin-email-first path
   *  (email is unverified during beta; a `user.id` can't be forged). Fail-closed.
   *  See isAdminSession in worker/identity.ts. */
  ADMIN_USER_IDS?: string;
  /** Legacy comma-separated admin email allowlist. Honored ONLY as a fallback
   *  when ADMIN_USER_IDS is empty (so an older deploy keeps working). Prefer
   *  ADMIN_USER_IDS. Fail-closed: neither set = no admins. */
  ADMIN_EMAILS?: string;
  /** Cloudflare Turnstile SITE key (#293) — PUBLIC (it ships to the browser), so
   *  a wrangler.jsonc var, not a secret. Surfaced to the SPA via
   *  GET /api/auth-config so the AuthScreen can render the widget. Unset = no
   *  key = no widget in the client (and the plugin is unregistered server-side
   *  when TURNSTILE_SECRET_KEY is also unset — dev/no-key parity). */
  TURNSTILE_SITE_KEY?: string;
}

/** A legacy D1 node row (booleans as 0/1). Only read during the one-time import
 *  of pre-DO data into a user's Durable Object. */
interface NodeRow {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: number;
  completed: number;
  collapsed: number;
  bookmarkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// Plugin side-collections backed by the kv store. The allowlist stops a client
// writing arbitrary collection namespaces.
const KV_COLLECTIONS = new Set([
  "tag-colors",
  "daily-index",
  "changelog",
  "saved-queries",
]);

/**
 * The provenance stamp for an MCP write: the human-facing name of the OAuth
 * client behind the bearer token. Dynamic client registration records it in
 * `oauthApplication.name` ("Claude", "MCP Inspector", …), so a node an agent
 * creates carries WHICH agent made it. One indexed lookup, on the MCP path only.
 * Falls back to a generic `'agent'` when the token carries no client id or the
 * client registered no name — the marker still reads as "not the user", unnamed.
 */
async function resolveMcpOrigin(
  env: Env,
  clientId: string | null,
): Promise<string> {
  if (!clientId) return "agent";
  const row = await env.DB.prepare(
    "SELECT name FROM oauthApplication WHERE clientId = ?",
  )
    .bind(clientId)
    .first<{ name: string }>();
  return row?.name?.trim() || "agent";
}

function rowToNode(r: NodeRow): Node {
  return {
    id: r.id,
    parentId: r.parentId,
    prevSiblingId: r.prevSiblingId,
    text: r.text,
    isTask: !!r.isTask,
    completed: !!r.completed,
    collapsed: !!r.collapsed,
    bookmarkedAt: r.bookmarkedAt,
    // Legacy D1 data predates mirrors (ADR 0022); the import source has no such
    // column, so every imported node is its own source.
    mirrorOf: null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    // Legacy D1 rows predate provenance and were all authored by the owner in
    // the editor, so they import as human (null) — never agent-stamped.
    origin: null,
    // Legacy D1 data predates paragraphs (ADR 0045): every imported node is a
    // bullet or a task, which is exactly what a null `kind` means.
    kind: null,
  };
}

function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// --- Typed domain errors ----------------------------------------------------

/**
 * The legacy D1 tables don't exist — expected on a clean deploy or a dev
 * environment without the legacy migrations applied. The seed import simply
 * skips; the DO starts from whatever state it already has.
 */
class SeedLegacyTablesAbsent extends Data.TaggedError(
  "SeedLegacyTablesAbsent",
)<{}> {}

/**
 * The `?collection=` parameter is missing or not in the KV_COLLECTIONS
 * allow-list. The client sent a collection name we don't serve.
 */
class UnknownCollection extends Data.TaggedError("UnknownCollection")<{
  collection: string | null;
}> {
  get message() {
    return `unknown kv collection: ${this.collection ?? "(none)"}`;
  }
}

/**
 * The request body failed validation at the trust boundary — malformed JSON, or
 * a shape the route's Effect Schema (worker/wire.ts) rejected (e.g. an op missing
 * its `value`). Caught at the outer boundary as a 400, so a bad body never
 * reaches the DO and dereferences `undefined` deep inside the SQLite write loop
 * (which would surface as a 500 from inside storage). See docs/adr/0014.
 */
class BadRequest extends Data.TaggedError("BadRequest")<{ reason: string }> {
  get message() {
    return `bad request: ${this.reason}`;
  }
}

/**
 * /api/sync was reached without a WebSocket Upgrade header. The caller must
 * open a proper WebSocket connection — plain HTTP is not accepted on this route.
 */
class UpgradeRequired extends Data.TaggedError("UpgradeRequired")<{}> {}

/** The request URL didn't match any /api/* route we own. */
class RouteNotFound extends Data.TaggedError("RouteNotFound")<{
  path: string;
}> {}

/**
 * A free-tier outline is at its node ceiling and the write would grow it past
 * the cap (#170). Mapped to a 403 whose body names the reason + limit so the
 * client can surface an upgrade prompt (mirroring the protected-node rejection).
 * Never raised for edits/moves/deletes, and never for a paid user — see
 * batchExceedsNodeLimit / the DO's applyBatchGated.
 */
class NodeLimitExceeded extends Data.TaggedError("NodeLimitExceeded")<{}> {}

// --- ensureSeededE ----------------------------------------------------------

/**
 * Effect-native one-time D1 → DO import. Returns `Effect<void, never>`:
 *
 * - `SeedLegacyTablesAbsent` (no legacy tables on a fresh deploy) is absorbed
 *   here — the seed call is skipped and the DO starts empty/as-is, which is
 *   the correct behaviour.
 * - A *real* D1 failure (network error, malformed SQL, unexpected table error)
 *   is promoted to an Effect *defect* via `Effect.die` so the DO is NOT marked
 *   seeded — the import will retry on the next load rather than silently losing
 *   the owner's pre-DO data.
 */
function ensureSeededE(
  stub: DurableObjectStub<UserOutlineDO>,
  env: Env,
): Effect.Effect<void> {
  const owner = env.APP_OWNER ?? "owner";

  // Fetch both legacy tables in parallel. The `SeedLegacyTablesAbsent` typed
  // error signals the expected "no legacy tables" case; any other thrown error
  // is promoted to a defect so the DO stays un-seeded and retries on next load.
  const queryLegacyData = Effect.callback<
    {
      nodeRows: NodeRow[];
      kvRows: { collection: string; key: string; value: string }[];
    },
    SeedLegacyTablesAbsent
  >((resume) => {
    Promise.all([
      env.DB.prepare(
        "SELECT id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt FROM nodes WHERE owner = ?",
      )
        .bind(owner)
        .all<NodeRow>(),
      env.DB.prepare("SELECT collection, key, value FROM kv WHERE owner = ?")
        .bind(owner)
        .all<{ collection: string; key: string; value: string }>(),
    ]).then(
      ([nodeResult, kvResult]) =>
        resume(
          Effect.succeed({
            nodeRows: nodeResult.results,
            kvRows: kvResult.results,
          }),
        ),
      (err) => {
        if (/no such table/i.test(String(err))) {
          // Expected on fresh deploys — no legacy rows to import.
          resume(Effect.fail(new SeedLegacyTablesAbsent()));
        } else {
          // Real D1 failure — promote to defect so we don't mark the DO seeded.
          resume(Effect.die(err));
        }
      },
    );
  });

  return Effect.gen(function* () {
    const seeded = yield* Effect.promise(() => stub.isSeeded());
    if (seeded) return;

    const data = yield* queryLegacyData.pipe(
      // Absorb the expected no-tables case: produce empty seed data so the
      // stub.seed() call still runs and marks the DO seeded, preventing
      // repeated D1 queries on every subsequent request.
      Effect.catchTag("SeedLegacyTablesAbsent", () =>
        Effect.succeed({
          nodeRows: [] as NodeRow[],
          kvRows: [] as { collection: string; key: string; value: string }[],
        }),
      ),
    );

    yield* Effect.promise(() =>
      stub.seed({
        nodes: data.nodeRows.map(rowToNode),
        kv: data.kvRows.map((r) => ({
          collection: r.collection,
          key: r.key,
          value: JSON.parse(r.value) as unknown,
        })),
      }),
    );
  });
}

// --- Route handlers ---------------------------------------------------------
// These return Effects whose typed error channel carries only `BadRequest` (a
// validation failure → 400). Real DO/runtime throws stay defects → 500. The DO
// write methods below operate only on already-decoded input, so they stay total.

/**
 * Parse a request's JSON body and decode it against `schema`, failing with a
 * typed `BadRequest` on either malformed JSON or a shape the schema rejects.
 * This is the trust-boundary gate (the schemas live in worker/wire.ts): a bad
 * body is rejected here, before it can reach the DO and fault mid-write.
 */
function decodeBody<S extends Schema.Top>(
  request: Request,
  schema: S,
): Effect.Effect<S["Type"], BadRequest, S["DecodingServices"]> {
  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => new BadRequest({ reason: "malformed JSON body" }),
    });
    return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError((issue) => new BadRequest({ reason: issue.message })),
    );
  });
}

function handleNodes(
  request: Request,
  stub: DurableObjectStub<UserOutlineDO>,
  env: Env,
  billingUserId: string,
): Effect.Effect<Response, BadRequest | NodeLimitExceeded> {
  return Effect.gen(function* () {
    switch (request.method) {
      case "GET":
        return json(yield* Effect.promise(() => stub.getNodes()));
      case "POST": {
        const { ops, nodes } = yield* decodeBody(request, NodesPostBody);
        // Atomic-batch path: a single structural mutation arrives as a list of
        // ops and persists as ONE DO frame (one seq, one broadcast). Reply with
        // that seq so the client can hold its optimistic overlay until the frame
        // echoes back — closing the half-applied / reverted-state window.
        //
        // Free-tier node ceiling (#170): resolve the caller's limit and let the
        // DO reject a batch that would grow the outline past it (null seq → 403).
        // A pure-delete batch can never grow the outline, so skip the plan query
        // (deletes are never blocked) — most structural edits (moves) DO touch
        // existing nodes, but the DO's per-op growth count makes that safe.
        //
        // getPlan takes the BILLING id (`session.user.id`), NOT the DO-routing id:
        // the subscription table is keyed on the raw Better Auth `user.id`, but
        // resolveUserId collapses the OWNER to the constant 'default' DO — so
        // querying the resolved id would miss the owner's comp row and wrongly
        // read `free`. Same split the MCP branch makes (getPlan(token.userId) with
        // a separately-resolved DO stub).
        if (ops) {
          const growable = ops.some((o) => o.op !== "delete");
          const limit = growable
            ? nodeLimitForPlan(
                yield* Effect.promise(() => getPlan(billingUserId, env)),
              )
            : null;
          const seq = yield* Effect.promise(() =>
            stub.applyBatchGated(ops, limit),
          );
          if (seq === null) return yield* Effect.fail(new NodeLimitExceeded());
          return json({ seq });
        }
        // Legacy upsert path: the first-run seed and any pre-batch client. Kept
        // for back-compat during rollout — gated too, so a raw POST can't slip
        // past the cap the batch path enforces.
        if (nodes?.length) {
          const limit = nodeLimitForPlan(
            yield* Effect.promise(() => getPlan(billingUserId, env)),
          );
          const applied = yield* Effect.promise(() =>
            stub.upsertNodesGated(nodes, limit),
          );
          if (!applied) return yield* Effect.fail(new NodeLimitExceeded());
        }
        return json({ ok: true });
      }
      case "PATCH": {
        const { updates } = yield* decodeBody(request, NodesPatchBody);
        if (updates.length)
          yield* Effect.promise(() => stub.patchNodes(updates));
        return json({ ok: true });
      }
      case "DELETE": {
        const { ids } = yield* decodeBody(request, NodesDeleteBody);
        if (ids.length) yield* Effect.promise(() => stub.deleteNodes(ids));
        return json({ ok: true });
      }
      default:
        return json({ error: "method not allowed" }, 405);
    }
  });
}

function handleKv(
  request: Request,
  stub: DurableObjectStub<UserOutlineDO>,
  collection: string,
): Effect.Effect<Response, BadRequest> {
  return Effect.gen(function* () {
    switch (request.method) {
      case "GET":
        return json(yield* Effect.promise(() => stub.getKv(collection)));
      case "POST": {
        // `?op=claim` is the atomic get-or-create: insert the value only if the
        // key is absent, return the authoritative one. Used by the daily plugin
        // to race-safely create today's note / container (the DO serializes it).
        if (new URL(request.url).searchParams.get("op") === "claim") {
          const { key, value } = yield* decodeBody(request, KvClaimBody);
          const claimed = yield* Effect.promise(() =>
            stub.getOrCreateKv(collection, key, value),
          );
          return json({ value: claimed });
        }
        const { rows } = yield* decodeBody(request, KvUpsertBody);
        if (rows.length)
          yield* Effect.promise(() => stub.upsertKv(collection, rows));
        return json({ ok: true });
      }
      case "DELETE": {
        const { keys } = yield* decodeBody(request, KvDeleteBody);
        if (keys.length)
          yield* Effect.promise(() => stub.deleteKv(collection, keys));
        return json({ ok: true });
      }
      default:
        return json({ error: "method not allowed" }, 405);
    }
  });
}

// --- Waitlist (public) --------------------------------------------------------

/** Origins allowed to POST the waitlist form cross-origin: the landing site
 *  (prod + its local dev port). Same-origin app requests need no CORS. */
const WAITLIST_ALLOWED_ORIGINS = new Set([
  "https://dotflowy.com",
  "https://www.dotflowy.com",
  "http://localhost:3100",
]);

function waitlistCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  return origin && WAITLIST_ALLOWED_ORIGINS.has(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin" }
    : {};
}

/**
 * POST /api/waitlist — the alpha waitlist behind the invite-only signup gate
 * (worker/auth.ts). PUBLIC by design (the people submitting have no account),
 * so it's hardened the other way: per-IP rate limit, shape-validated body,
 * normalized email into one D1 table. A duplicate email is a silent no-op and
 * still returns ok — the response never reveals whether an address is already
 * on the list.
 */
function handleWaitlist(
  request: Request,
  env: Env,
): Effect.Effect<Response, BadRequest> {
  return Effect.gen(function* () {
    const cors = waitlistCorsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "POST")
      return json({ error: "method not allowed" }, 405, cors);

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = yield* Effect.promise(() =>
      env.WAITLIST_LIMIT.limit({ key: ip }),
    );
    if (!success) return json({ error: "rate limited" }, 429, cors);

    const { email, source } = yield* decodeBody(request, WaitlistPostBody);
    const normalized = email.trim().toLowerCase();
    if (!isPlausibleEmail(normalized)) {
      return yield* Effect.fail(new BadRequest({ reason: "invalid email" }));
    }
    yield* Effect.promise(() =>
      env.DB.prepare(
        "INSERT INTO waitlist (email, source, createdAt) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING",
      )
        .bind(normalized, source === "landing" ? "landing" : "app", Date.now())
        .run(),
    );
    return json({ ok: true }, 200, cors);
  });
}

/** Default number of pending waitlist rows a batch invites when neither
 *  explicit emails nor `all` is given. Kept small so a bare call is safe. */
const INVITE_BATCH_DEFAULT = 25;
const INVITE_BATCH_MAX = 500;

/**
 * Resolve the target addresses for an admin invite batch, then mint + email a
 * per-email single-use code for each (#251). Explicit `emails` win; otherwise it
 * pulls pending (not-yet-invited) waitlist rows — every row with `all`, else the
 * oldest `limit`. Runs on the Worker because mintInvites sends through the
 * `send_email` binding, which only exists here.
 */
async function runInviteBatch(
  env: Env,
  body: { emails?: readonly string[]; all?: boolean; limit?: number },
  origin: string,
): Promise<InviteBatchResult & { count: number }> {
  const signupUrl = `${origin}/`;
  let targets: string[];
  if (body.emails && body.emails.length > 0) {
    targets = body.emails.map(normalizeEmail).filter(isPlausibleEmail);
  } else {
    const limit = body.all
      ? null
      : Math.max(
          1,
          Math.min(body.limit ?? INVITE_BATCH_DEFAULT, INVITE_BATCH_MAX),
        );
    targets = await pendingWaitlistEmails(env, limit);
  }
  const result = await mintInvites(env, targets, signupUrl);
  return { ...result, count: result.invited.length };
}

/** Default number of pending waitlist rows a batch announces to when neither
 *  explicit emails nor `all` is given. Kept small so a bare call is safe. */
const ANNOUNCE_BATCH_DEFAULT = 25;
const ANNOUNCE_BATCH_MAX = 500;

/** The public site where signup is now open (#294). The launch blast points at
 *  the marketing origin, NOT the app origin the invite email uses — signup
 *  graduated to public here. Pinned, not derived from url.origin. */
const ANNOUNCE_SIGNUP_URL = "https://dotflowy.com";

/**
 * Resolve the target addresses for an admin announcement batch, then email + stamp
 * each (#294). Explicit `emails` win; otherwise it pulls not-yet-notified waitlist
 * rows — every row with `all`, else the oldest `limit`. Runs on the Worker because
 * sendAnnouncements sends through the `send_email` binding, which only exists here.
 * The `notifiedAt` stamp (migration 0009) makes a re-run safe to re-send.
 */
async function runAnnounceBatch(
  env: Env,
  body: { emails?: readonly string[]; all?: boolean; limit?: number },
): Promise<AnnounceBatchResult & { count: number }> {
  let targets: string[];
  if (body.emails && body.emails.length > 0) {
    targets = body.emails.map(normalizeEmail).filter(isPlausibleEmail);
  } else {
    const limit = body.all
      ? null
      : Math.max(
          1,
          Math.min(body.limit ?? ANNOUNCE_BATCH_DEFAULT, ANNOUNCE_BATCH_MAX),
        );
    targets = await pendingAnnounceEmails(env, limit);
  }
  const result = await sendAnnouncements(env, targets, ANNOUNCE_SIGNUP_URL);
  return { ...result, count: result.notified.length };
}

// --- Admin restore (PITR) ----------------------------------------------------

/**
 * Resolve the target user id for an admin restore from EXACTLY one of `userId`
 * / `email`. The DO is keyed by the stable `user.id` (a DO name is permanent —
 * never key it off an email); an `email` is only a lookup into D1's identity
 * `user` table (case-insensitive, forgiving of how it was entered). Fails with a
 * typed `BadRequest` on both-or-neither, or an email with no account — mapped to
 * a clean 400, never a DO round-trip.
 */
function resolveRestoreUserId(
  env: Env,
  body: { userId?: string; email?: string },
): Effect.Effect<string, BadRequest> {
  return Effect.gen(function* () {
    const userId = body.userId?.trim();
    const email = body.email?.trim();
    if (userId && email) {
      return yield* Effect.fail(
        new BadRequest({
          reason: "provide either a user id or an email, not both",
        }),
      );
    }
    if (userId) return userId;
    if (!email) {
      return yield* Effect.fail(
        new BadRequest({ reason: "a user id or an email is required" }),
      );
    }
    const row = yield* Effect.promise(() =>
      env.DB.prepare('SELECT id FROM "user" WHERE lower(email) = lower(?)')
        .bind(email)
        .first<{ id: string }>(),
    );
    if (!row) {
      return yield* Effect.fail(
        new BadRequest({ reason: `no user with email ${email}` }),
      );
    }
    return row.id;
  });
}

// --- Main API pipeline ------------------------------------------------------

/**
 * Routes an authenticated /api/* request. Returns an Effect whose typed error
 * channel carries only the *expected* validation failures — callers can
 * exhaustively handle them with `Effect.catchTag`. Unexpected failures (DO
 * errors, D1 errors, runtime throws) escape as defects and surface as 500s via
 * the `runPromise().catch()` in `fetch`.
 */
function handleApiRequest(
  request: Request,
  url: URL,
  env: Env,
  executionCtx: ExecutionContext,
): Effect.Effect<
  Response,
  | UnknownCollection
  | UpgradeRequired
  | RouteNotFound
  | BadRequest
  | NodeLimitExceeded
> {
  return Effect.gen(function* () {
    // executionCtx lets auth ride transactional-email sends on waitUntil
    // (worker/auth.ts sendResetPassword) instead of blocking the response.
    const auth = createAuth(env, url.origin, executionCtx);

    // Better Auth owns everything under /api/auth/* (sign-up/in/out, session,
    // and — via the mcp plugin — the OAuth authorize/token/register endpoints).
    if (url.pathname.startsWith("/api/auth/")) {
      return yield* Effect.promise(() => auth.handler(request));
    }

    // Public signup config (#293): the SPA reads whether signup is OPEN (hide
    // the invite field) and the PUBLIC Turnstile site key (render the widget).
    // No session, no DO — dumb + static, like the OAuth discovery routes. Sits
    // before the session gate on purpose (the signed-out AuthScreen fetches it).
    // A missing key returns null so the client renders no widget, which matches
    // the server registering no captcha plugin — dev/no-key parity.
    if (url.pathname === "/api/auth-config") {
      return json({
        signupOpen: isSignupOpen(env),
        turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
      });
    }

    // Alpha waitlist: POST is PUBLIC (submitters have no account yet) — must
    // sit before the session gate below; its hardening lives in handleWaitlist.
    // GET is the ADMIN view (the /admin/waitlist page): session + the
    // ADMIN_EMAILS allowlist. Non-admins get the same 404 as a route that
    // doesn't exist — the admin surface shouldn't advertise itself.
    if (url.pathname === "/api/waitlist") {
      if (request.method === "GET") {
        const session = yield* Effect.promise(() =>
          auth.api.getSession({ headers: request.headers }),
        );
        if (!isAdminSession(session, env)) {
          return yield* Effect.fail(new RouteNotFound({ path: url.pathname }));
        }
        const { results } = yield* Effect.promise(() =>
          env.DB.prepare(
            "SELECT email, source, createdAt FROM waitlist ORDER BY createdAt DESC",
          ).all<{ email: string; source: string; createdAt: number }>(),
        );
        return json({ entries: results });
      }
      return yield* handleWaitlist(request, env);
    }

    // Admin-only: mint + email per-email single-use invite codes (#251). Sits
    // before the generic session gate so it can 404 (not 401) for non-admins —
    // the admin surface shouldn't advertise itself, same as the waitlist GET.
    // Session + ADMIN_EMAILS gated; driven by scripts/invite.ts. Lives on the
    // Worker because the send needs the `send_email` binding, which only exists
    // here.
    if (url.pathname === "/api/admin/invite") {
      // Admin-gate FIRST, then method-check: a non-admin gets the same 404 for
      // any method, so a wrong-method probe can't confirm the route exists (the
      // 405 is only for authenticated admins). Mirrors the waitlist GET.
      const session = yield* Effect.promise(() =>
        auth.api.getSession({ headers: request.headers }),
      );
      if (!isAdminSession(session, env)) {
        return yield* Effect.fail(new RouteNotFound({ path: url.pathname }));
      }
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      const body = yield* decodeBody(request, AdminInvitePostBody);
      return json(
        yield* Effect.promise(() => runInviteBatch(env, body, url.origin)),
      );
    }

    // Admin-only: email the launch "Dotflowy is open" blast to the waitlist
    // (#294). Same 404-not-401 admin gate + method order as /api/admin/invite —
    // the surface shouldn't advertise itself. Driven by scripts/announce.ts.
    // Lives on the Worker because the send needs the `send_email` binding; the
    // `notifiedAt` stamp (migration 0009) makes it safe to re-run.
    if (url.pathname === "/api/admin/announce") {
      const session = yield* Effect.promise(() =>
        auth.api.getSession({ headers: request.headers }),
      );
      if (!isAdminSession(session, env)) {
        return yield* Effect.fail(new RouteNotFound({ path: url.pathname }));
      }
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      const body = yield* decodeBody(request, AdminAnnouncePostBody);
      return json(yield* Effect.promise(() => runAnnounceBatch(env, body)));
    }

    // Admin-only: restore ONE user's outline to a point in the DO's free 30-day
    // Point-in-Time Recovery window (#220). Same 404-not-401 admin gate as the
    // waitlist/invite routes (the surface shouldn't advertise itself). Isolation
    // is by construction: the route addresses one DO by the target's user id, so
    // no other user is ever touched. The route resolves the id (never the email)
    // and routes through resolveUserId, so restoring the OWNER hits the 'default'
    // DO. PITR is unavailable in local dev — see docs/runbooks/restore-user-pitr.md.
    if (url.pathname === "/api/admin/restore") {
      const session = yield* Effect.promise(() =>
        auth.api.getSession({ headers: request.headers }),
      );
      if (!isAdminSession(session, env)) {
        return yield* Effect.fail(new RouteNotFound({ path: url.pathname }));
      }
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      const body = yield* decodeBody(request, AdminRestorePostBody);

      // Identity: EXACTLY one of userId / email. The DO is keyed by the stable
      // user id, never the email (a DO name is permanent) — an email only looks
      // one up in D1's identity table.
      const targetUserId = yield* resolveRestoreUserId(env, body);

      // Where in time (pure, unit-tested): a timestamp within the 30-day window
      // or a raw bookmark (the undo path). A bad shape is a clean 400 here, not a
      // 500 from getBookmarkForTime deep in the DO.
      const target = resolveRestorePoint(body, Date.now());
      if (!target.ok) {
        return yield* Effect.fail(new BadRequest({ reason: target.reason }));
      }

      const restoreStub = env.USER_OUTLINE.get(
        env.USER_OUTLINE.idFromName(resolveUserId(targetUserId, env)),
      );
      const result = yield* Effect.promise(() =>
        restoreStub.restoreToTime(target.point),
      );
      return json(result);
    }

    // Admin-only: list one user's off-site snapshots in R2 (#221) — what dates
    // are available to restore-snapshot below. Same 404-not-401 admin gate.
    if (url.pathname === "/api/admin/backups") {
      const session = yield* Effect.promise(() =>
        auth.api.getSession({ headers: request.headers }),
      );
      if (!isAdminSession(session, env)) {
        return yield* Effect.fail(new RouteNotFound({ path: url.pathname }));
      }
      if (request.method !== "GET") {
        return json({ error: "method not allowed" }, 405);
      }
      const targetUserId = yield* resolveRestoreUserId(env, {
        userId: url.searchParams.get("userId") ?? undefined,
        email: url.searchParams.get("email") ?? undefined,
      });
      const doName = resolveUserId(targetUserId, env);
      // R2 list caps at 1000 objects per call; follow the cursor so the
      // listing stays complete even if the lifecycle expiry was never applied
      // (list order is lexicographic-ascending = oldest date first, so a
      // truncated single call would hide exactly the recent, useful dates).
      const backups: { key: string; size: number; uploaded: string }[] = [];
      let cursor: string | undefined;
      do {
        const listed: R2Objects = yield* Effect.promise(() =>
          env.BACKUPS.list({ prefix: backupPrefix(doName), cursor }),
        );
        for (const o of listed.objects) {
          backups.push({
            key: o.key,
            size: o.size,
            uploaded: o.uploaded.toISOString(),
          });
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return json({ doName, backups });
    }

    // Admin-only: restore ONE user's outline from an off-site R2 snapshot
    // (#221) — the deep path pairing the daily export sweep, for losses older
    // than PITR's 30-day window. DESTRUCTIVE (truncate + reseed), but the DO
    // returns the pre-restore bookmark, so the undo path is the PITR route
    // above with that bookmark. Same identity resolution and 404-not-401 admin
    // gate as the PITR restore; the snapshot is schema-validated before it can
    // reach the DO's SQLite (ADR 0014 — R2 content is still a trust boundary).
    if (url.pathname === "/api/admin/restore-snapshot") {
      const session = yield* Effect.promise(() =>
        auth.api.getSession({ headers: request.headers }),
      );
      if (!isAdminSession(session, env)) {
        return yield* Effect.fail(new RouteNotFound({ path: url.pathname }));
      }
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      const body = yield* decodeBody(request, AdminSnapshotRestorePostBody);
      if (!isBackupDateKey(body.date)) {
        return yield* Effect.fail(
          new BadRequest({ reason: "date must be YYYY-MM-DD" }),
        );
      }
      const targetUserId = yield* resolveRestoreUserId(env, body);
      const doName = resolveUserId(targetUserId, env);
      // String concatenation, never Date.parse: a calendar-invalid shape like
      // 2026-02-31 must land as a clean "no backup" 400, not a NaN→RangeError
      // defect (a 500) from re-deriving the key through a Date round-trip.
      const key = backupKeyForDate(doName, body.date);
      const object = yield* Effect.promise(() => env.BACKUPS.get(key));
      if (!object) {
        return yield* Effect.fail(
          new BadRequest({ reason: `no backup at ${key}` }),
        );
      }
      const raw = yield* Effect.tryPromise({
        try: () => object.json(),
        catch: () => new BadRequest({ reason: "snapshot is not valid JSON" }),
      });
      const snapshot = yield* Schema.decodeUnknownEffect(OutlineSnapshotSchema)(
        raw,
      ).pipe(
        Effect.mapError(
          (issue) =>
            new BadRequest({ reason: `snapshot rejected: ${issue.message}` }),
        ),
      );
      if (snapshot.version !== SNAPSHOT_VERSION) {
        return yield* Effect.fail(
          new BadRequest({
            reason: `unknown snapshot version ${snapshot.version}`,
          }),
        );
      }
      const snapshotStub = env.USER_OUTLINE.get(
        env.USER_OUTLINE.idFromName(doName),
      );
      const result = yield* Effect.promise(() =>
        snapshotStub.restoreSnapshot({
          nodes: snapshot.nodes,
          kv: snapshot.kv,
        }),
      );
      return json({ key, ...result });
    }

    // The MCP endpoint authenticates with an OAuth BEARER TOKEN (issued by the
    // mcp plugin, stored in D1), not the session cookie, so it's gated here —
    // before the cookie-session check below. Same identity model though: the
    // token's user id routes to the same per-user DO as the browser session,
    // so an agent and the editor share one outline, live. ADR 0026. Served at
    // the ecosystem-default `/mcp` (what clients probe); `/api/mcp` stays a
    // working alias so an already-configured client keeps connecting.
    if (url.pathname === "/mcp" || url.pathname === "/api/mcp") {
      if (request.method === "OPTIONS") return mcpCorsPreflight();
      const token = yield* Effect.promise(() =>
        auth.api.getMcpSession({ headers: request.headers }),
      );
      if (!token?.userId) {
        // RFC 9728: point the client at the protected-resource metadata so it
        // can discover the authorization server and start the OAuth flow.
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "WWW-Authenticate",
          },
        });
      }
      const mcpUserId = resolveUserId(token.userId, env);
      const mcpStub = env.USER_OUTLINE.get(
        env.USER_OUTLINE.idFromName(mcpUserId),
      );
      // Provenance: which agent is calling. The bearer token's OAuth client maps
      // to a registered harness name; every node its write tools create is
      // stamped with it, so the editor can mark agent edits apart from the user's.
      const clientId = (token as { clientId?: string }).clientId ?? null;
      const origin = yield* Effect.promise(() =>
        resolveMcpOrigin(env, clientId),
      );
      // MCP (agent access) is a paid capability (#152/#170). Resolve the plan
      // from the token's `userId` — the Better Auth id the subscription table is
      // keyed on (never the resolved DO id, which collapses the owner to
      // 'default'). A free token gets a clean in-protocol error on tool calls
      // (handleMcp), not a 500. An operator comps themselves with a manual
      // subscription row (getPlan treats it as paid).
      const mcpPlan = yield* Effect.promise(() => getPlan(token.userId, env));
      return yield* handleMcp(request, mcpStub, origin, mcpPlan !== "free");
    }

    // Identity = the validated session's stable user id. No session → 401.
    const session = yield* Effect.promise(() =>
      auth.api.getSession({ headers: request.headers }),
    );
    if (!session) return json({ error: "unauthorized" }, 401);

    const userId = resolveUserId(session.user.id, env);

    // Link title unfurl (ADR 0016): fetch a pasted URL's <title> server-side so
    // a bare-url link can upgrade its label. DO-independent, so it runs before
    // the per-user stub is resolved. The ONLY 400 is a missing / non-http(s)
    // `url` param; every other "no title" reason (blocked target, non-HTML,
    // unreachable, timeout) is a 200 `{title:null}` from unfurlTitleE. Per-user
    // rate-limited (the fetch is an authenticated SSRF surface).
    if (url.pathname === "/api/unfurl") {
      const target = url.searchParams.get("url");
      if (!target || !isHttpUrlString(target)) {
        return yield* Effect.fail(
          new BadRequest({ reason: "missing or non-http(s) url param" }),
        );
      }
      const { success } = yield* Effect.promise(() =>
        env.UNFURL_LIMIT.limit({ key: userId }),
      );
      if (!success) return json({ error: "rate limited" }, 429);
      return json({ title: yield* unfurlTitleE(target) });
    }

    const stub = env.USER_OUTLINE.get(env.USER_OUTLINE.idFromName(userId));

    // Only the owner's DO ('default') has legacy D1 rows to import; new users
    // start empty, so skip the import (and its D1 query) for them.
    const maybeSeed =
      request.method === "GET" && userId === OWNER_DO_ID
        ? ensureSeededE(stub, env)
        : Effect.sync(() => {});

    // Real-time sync: a WebSocket upgrade, forwarded to the caller's DO, which
    // hibernation-accepts it and streams outline changes. The session is
    // already validated above, so the socket only ever opens for an authed
    // user. Seed first (owner only) so the DO's initial snapshot includes any
    // imported legacy rows — the live client no longer GETs /api/nodes.
    if (url.pathname === "/api/sync") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return yield* Effect.fail(new UpgradeRequired());
      }
      yield* maybeSeed;
      return yield* Effect.promise(() => stub.fetch(request));
    }

    if (url.pathname === "/api/nodes") {
      yield* maybeSeed;
      // `stub` routes on the resolved `userId` (owner → 'default'); the plan
      // lookup takes the raw billing id (`session.user.id`) — see handleNodes.
      return yield* handleNodes(request, stub, env, session.user.id);
    }

    if (url.pathname === "/api/kv") {
      const collection = url.searchParams.get("collection");
      if (!collection || !KV_COLLECTIONS.has(collection)) {
        return yield* Effect.fail(new UnknownCollection({ collection }));
      }
      yield* maybeSeed;
      return yield* handleKv(request, stub, collection);
    }

    return yield* Effect.fail(new RouteNotFound({ path: url.pathname }));
  });
}

// --- Off-site backup sweep (#221) -------------------------------------------

/**
 * Export every user's outline to R2, one JSON snapshot per Durable Object per
 * UTC day (a same-day re-run overwrites — idempotent). Driven by the D1 `user`
 * table (the authoritative id set — deliberately not the eventually-consistent
 * DO enumeration API, per the #155 research), with the owner mapped to the
 * 'default' DO via `backupTargets`. Per-user failures are contained: one
 * broken DO must not starve every user after it of their daily backup, so
 * each export is try/caught, reported to Sentry, and the sweep moves on.
 */
async function runBackupSweep(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id FROM "user"').all<{
    id: string;
  }>();
  const targets = backupTargets(
    results.map((r) => r.id),
    (id) => resolveUserId(id, env),
  );
  let failed = 0;
  for (const doName of targets) {
    try {
      const stub = env.USER_OUTLINE.get(env.USER_OUTLINE.idFromName(doName));
      const snapshot = await stub.exportSnapshot();
      await env.BACKUPS.put(backupKey(doName, now), JSON.stringify(snapshot), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (err) {
      failed++;
      console.error(`backup sweep: export failed for DO ${doName}`, err);
      Sentry.captureException(err);
    }
  }
  console.log(
    `backup sweep: ${targets.length - failed}/${targets.length} DOs exported`,
  );
}

const handler = {
  // Daily off-site backup sweep (#221) — the cron trigger in wrangler.jsonc.
  // AWAITED, not waitUntil: cron handlers get 15 min of wall clock (ample for
  // a per-user export loop at beta scale), and a detached waitUntil promise
  // would put a sweep-level failure (e.g. the D1 user query) outside Sentry's
  // withSentry catch/flush window — the nightly backup could silently stop.
  // Awaiting keeps a total failure loud; per-user failures are contained
  // inside runBackupSweep.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await runBackupSweep(env, event.scheduledTime);
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // OAuth discovery for MCP clients (RFC 8414 / RFC 9728). These MUST live at
    // the site root — clients resolve them from the resource origin, not from
    // Better Auth's /api/auth base path — and they're public by spec. The
    // helpers proxy to the mcp plugin's metadata endpoints.
    // Prefix-match, not exact: RFC 9728 clients probe a PATH-AWARE variant
    // (`/.well-known/oauth-protected-resource/mcp`) before the root one. The
    // metadata is path-independent (resource = origin), so answer either shape;
    // an exact match 404s the suffixed probe and the SDK chokes parsing it.
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return oAuthDiscoveryMetadata(createAuth(env, url.origin))(request);
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return oAuthProtectedResourceMetadata(createAuth(env, url.origin))(
        request,
      );
    }

    // Lunora reserved paths (ADR 0055 Phase-2 compose). Product Better Auth
    // stays on `/api/auth/*`; Lunora has no dual signup here — identity is
    // bridged from the product session inside `worker/lunora-app.ts`.
    if (url.pathname === "/_lunora" || url.pathname.startsWith("/_lunora/")) {
      return lunoraApp.fetch(request, env, ctx);
    }

    // The static shell + assets are PUBLIC so the login screen can load. Serve
    // them without instantiating auth — only the data API (and the token-gated
    // `/mcp`, handled in the pipeline below) is gated.
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // Run the typed pipeline. Typed errors (validation) are caught here and
    // mapped to exact HTTP status codes. Defects (unexpected DO/D1 failures)
    // fall through to the Promise rejection handler, keeping the status code
    // mapping exhaustive and the 500 path reserved for genuine surprises.
    return Effect.runPromise(
      handleApiRequest(request, url, env, ctx).pipe(
        Effect.catchTag("BadRequest", (e) =>
          Effect.succeed(json({ error: e.message }, 400)),
        ),
        Effect.catchTag("UnknownCollection", (e) =>
          Effect.succeed(json({ error: e.message }, 400)),
        ),
        Effect.catchTag("UpgradeRequired", () =>
          Effect.succeed(json({ error: "expected a websocket upgrade" }, 426)),
        ),
        Effect.catchTag("RouteNotFound", () =>
          Effect.succeed(json({ error: "not found" }, 404)),
        ),
        // 403 with a machine-readable body the client keys on to show an upgrade
        // prompt (src/data/nodes-client-effect.ts NodesLimitError).
        Effect.catchTag("NodeLimitExceeded", () =>
          Effect.succeed(
            json({ error: "node_limit", limit: FREE_NODE_LIMIT }, 403),
          ),
        ),
      ),
    ).catch((err) => {
      // Reachable unauthenticated via /api/waitlist, so the body must NOT echo
      // the internal error string (audit #159, finding 1) — it goes to Workers
      // Logs + Sentry (#227) instead, and the client gets a constant. Sentry's
      // `withSentry` never sees this rejection on its own: the `.catch`
      // swallows it before it escapes the handler, so capture it here.
      console.error(err);
      Sentry.captureException(err);
      return json({ error: "internal error" }, 500);
    });
  },
} satisfies ExportedHandler<Env>;

// Errors-only Sentry around the whole Worker (#227). Dormant when SENTRY_DSN is
// unset (local dev, tests), so nothing phones home there. The callback is typed
// to the full `Env` so `withSentry` keeps the handler's env type (it otherwise
// infers the narrower `SentryEnv` from `workerSentryOptions`).
export default Sentry.withSentry(
  (env: Env) => workerSentryOptions(env),
  handler,
);
