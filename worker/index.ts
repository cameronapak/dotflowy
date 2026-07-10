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

import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import { Data, Effect, Schema } from "effect";

import type { AuthEnv } from "./auth";
import type { Node } from "./wire";

import { createAuth } from "./auth";
import { handleMcp, mcpCorsPreflight } from "./mcp";
import { UserOutlineDO } from "./outline-do";
import { isHttpUrlString, unfurlTitle } from "./unfurl";
import {
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
export { UserOutlineDO };

interface Env extends AuthEnv {
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
  /** Per-user rate limiter for the link-title unfurl endpoint (ADR 0016). */
  UNFURL_LIMIT: RateLimit;
  /** Per-IP rate limiter for the public alpha-waitlist endpoint. */
  WAITLIST_LIMIT: RateLimit;
  /** Comma-separated emails allowed on admin surfaces (the waitlist view).
   *  Fail-closed: unset = no admins. Email is fine HERE (unlike DO keying) —
   *  it's an allowlist entry, not a permanent storage key; if the admin's
   *  email changes, update the var in wrangler.jsonc. */
  ADMIN_EMAILS?: string;
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
const KV_COLLECTIONS = new Set(["tag-colors", "daily-index"]);

/**
 * The Durable Object name for the signed-in user's outline.
 *
 * LOCKED DECISION: a DO name is permanent and cannot be renamed, so it must
 * never be an email or any value that can change — keying by email would orphan
 * a user's whole outline on an email or auth-provider change. We key by the
 * session's stable `user.id`. Do NOT key this off the email.
 *
 * The one exception is the owner-continuity bridge: the pre-auth outline lives
 * in the constant 'default' DO (seeded from legacy D1). Setting OWNER_USER_ID to
 * the owner's `user.id` maps that one account back to 'default', carrying their
 * existing data over with zero copy. Removable once that data is wherever it
 * belongs.
 */
const OWNER_DO_ID = "default";

function resolveUserId(sessionUserId: string, env: Env): string {
  if (env.OWNER_USER_ID && sessionUserId === env.OWNER_USER_ID)
    return OWNER_DO_ID;
  return sessionUserId;
}

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
): Effect.Effect<Response, BadRequest> {
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
        if (ops) {
          const seq = yield* Effect.promise(() => stub.applyBatch(ops));
          return json({ seq });
        }
        // Legacy upsert path: the first-run seed and any pre-batch client. Kept
        // for back-compat during rollout.
        if (nodes?.length) yield* Effect.promise(() => stub.upsertNodes(nodes));
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

/** Good-enough shape check for an address someone wants an invite sent to.
 *  Deliverability is unknowable here; this only rejects obvious junk. */
function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Is this session's email on the ADMIN_EMAILS allowlist? Fail-closed. */
function isAdminSession(
  session: { user: { email: string } } | null,
  env: Env,
): boolean {
  if (!session) return false;
  const admins = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(session.user.email.toLowerCase());
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
): Effect.Effect<
  Response,
  UnknownCollection | UpgradeRequired | RouteNotFound | BadRequest
> {
  return Effect.gen(function* () {
    const auth = createAuth(env, url.origin);

    // Better Auth owns everything under /api/auth/* (sign-up/in/out, session,
    // and — via the mcp plugin — the OAuth authorize/token/register endpoints).
    if (url.pathname.startsWith("/api/auth/")) {
      return yield* Effect.promise(() => auth.handler(request));
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
      return yield* handleMcp(request, mcpStub, origin);
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
    // unreachable, timeout) is a 200 `{title:null}` from unfurlTitle. Per-user
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
      return json({ title: yield* Effect.promise(() => unfurlTitle(target)) });
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
      return yield* handleNodes(request, stub);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      handleApiRequest(request, url, env).pipe(
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
      ),
    ).catch((err) => json({ error: String(err) }, 500));
  },
} satisfies ExportedHandler<Env>;
