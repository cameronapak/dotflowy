/// <reference types="@cloudflare/workers-types" />
import { Effect, Schema } from "effect";

const ConsentValue = Schema.Struct({
  userId: Schema.String,
  clientId: Schema.String,
  redirectURI: Schema.String,
  requireConsent: Schema.Boolean,
  scope: Schema.Array(Schema.String),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
      "SELECT name, redirectUrls FROM oauthApplication WHERE clientId = ? AND (disabled IS NULL OR disabled = 0)",
    )
    .bind(value.clientId)
    .first<{ name: string; redirectUrls: string }>();
  if (!client || !client.redirectUrls.split(",").includes(value.redirectURI))
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
        SELECT DISTINCT a.clientId, a.name FROM oauthApplication a
        INNER JOIN oauthAccessToken t ON t.clientId = a.clientId
        WHERE t.userId = ? AND (t.accessTokenExpiresAt > ? OR t.refreshTokenExpiresAt > ?)
        ORDER BY a.name, a.clientId
      `)
          .bind(userId, new Date().toISOString(), new Date().toISOString())
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
            "DELETE FROM oauthAccessToken WHERE userId = ? AND clientId = ?",
          )
          .bind(userId, clientId),
        db
          .prepare("DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?")
          .bind(userId, clientId),
        db
          .prepare(
            `DELETE FROM verification WHERE json_valid(value) AND json_extract(value, '$.userId') = ? AND json_extract(value, '$.clientId') = ?`,
          )
          .bind(userId, clientId),
      ]),
    );
    return reply({ revoked: true });
  });
}
