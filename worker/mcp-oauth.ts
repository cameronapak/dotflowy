/// <reference types="@cloudflare/workers-types" />
import { Effect, Schema } from "effect";

export async function grantEpoch(
  db: D1Database,
  userId: string,
  clientId: string,
) {
  await db
    .prepare(
      "INSERT INTO mcpGrant (userId, clientId, epoch) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
    )
    .bind(userId, clientId)
    .run();
  const row = await db
    .prepare("SELECT epoch FROM mcpGrant WHERE userId = ? AND clientId = ?")
    .bind(userId, clientId)
    .first<{ epoch: number }>();
  return row?.epoch ?? -1;
}

const ConsentValue = Schema.Struct({
  userId: Schema.String,
  clientId: Schema.String,
  redirectURI: Schema.String,
  requireConsent: Schema.Boolean,
  scope: Schema.Array(Schema.String),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
  oauthQuery: Schema.String,
  epoch: Schema.Number,
});

/** Read provider-owned state, never client-supplied names, scopes or redirects. */
export async function readMcpConsent(
  db: D1Database,
  userId: string,
  code: string,
) {
  const row = await db
    .prepare(
      "SELECT value FROM verification WHERE identifier = ? AND expiresAt > ?",
    )
    .bind(code, new Date().toISOString())
    .first<{ value: string }>();
  if (!row) return null;
  const parsed = Schema.decodeUnknownResult(
    Schema.fromJsonString(ConsentValue),
  )(row.value);
  if (parsed._tag === "Failure") return null;
  const value = parsed.success;
  if (!value.requireConsent || value.userId !== userId) return null;
  const client = await db
    .prepare(
      "SELECT name, redirectUris FROM oauthClient WHERE clientId = ? AND (disabled IS NULL OR disabled = 0)",
    )
    .bind(value.clientId)
    .first<{ name: string; redirectUris: string }>();
  if (!client) return null;
  const redirects = Schema.decodeUnknownResult(
    Schema.fromJsonString(Schema.Array(Schema.String)),
  )(client.redirectUris);
  if (
    redirects._tag === "Failure" ||
    !redirects.success.includes(value.redirectURI) ||
    value.epoch !== (await grantEpoch(db, userId, value.clientId))
  )
    return null;
  return { ...value, name: client.name };
}

const RevokeBody = Schema.Struct({ clientId: Schema.String });

/** Browser-session-only management; API keys and OAuth bearers never enter here. */
export function handleMcpConnections(
  request: Request,
  db: D1Database,
  userId: string,
) {
  return Effect.gen(function* () {
    const reply = <T>(body: T, status = 200) =>
      Response.json(body, {
        status,
        headers: { "cache-control": "private, no-store" },
      });
    if (request.method === "GET") {
      const clients = yield* Effect.promise(() =>
        db
          .prepare(`
        SELECT DISTINCT a.clientId, a.name FROM oauthClient a
        WHERE EXISTS (SELECT 1 FROM oauthAccessToken t WHERE t.clientId = a.clientId AND t.userId = ? AND t.expiresAt > ? AND t.revoked IS NULL)
        OR EXISTS (SELECT 1 FROM oauthRefreshToken r WHERE r.clientId = a.clientId AND r.userId = ? AND r.expiresAt > ? AND r.revoked IS NULL)
        ORDER BY a.name, a.clientId
      `)
          .bind(
            userId,
            new Date().toISOString(),
            userId,
            new Date().toISOString(),
          )
          .all<{ clientId: string; name: string }>(),
      );
      return reply({ connections: clients.results });
    }
    if (request.method !== "DELETE")
      return reply({ error: "method not allowed" }, 405);
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return reply({ error: "invalid origin" }, 403);
    const raw = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.orElseSucceed(() => null),
    );
    const body = yield* Schema.decodeUnknownEffect(RevokeBody)(raw).pipe(
      Effect.option,
    );
    if (body._tag === "None") return reply({ error: "invalid request" }, 400);
    const clientId = body.value.clientId;
    // One D1 transaction: all grants for this user/client, not the shared client
    // registration or other users. Pending codes must not resurrect access.
    yield* Effect.promise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO mcpGrant (userId, clientId, epoch) SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM oauthClient WHERE clientId = ?) ON CONFLICT(userId, clientId) DO UPDATE SET epoch = epoch + 1",
          )
          .bind(userId, clientId, clientId),
        db
          .prepare(
            "DELETE FROM oauthAccessToken WHERE userId = ? AND clientId = ?",
          )
          .bind(userId, clientId),
        db
          .prepare(
            "DELETE FROM oauthRefreshToken WHERE userId = ? AND clientId = ?",
          )
          .bind(userId, clientId),
        db
          .prepare("DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?")
          .bind(userId, clientId),
        db
          .prepare(
            `DELETE FROM verification WHERE json_valid(value) AND json_extract(value, '$.userId') = ? AND COALESCE(json_extract(value, '$.clientId'), json_extract(value, '$.query.client_id')) = ?`,
          )
          .bind(userId, clientId),
      ]),
    );
    return reply({ revoked: true });
  });
}
