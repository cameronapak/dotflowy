/// <reference types="@cloudflare/workers-types" />

import { Effect, Schema } from "effect";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import { internal } from "../lunora/_generated/api";
import {
  AdminAnalyticsReport,
  AnalyticsSummary,
  ClassicAnalyticsMetadata,
  ExperimentalAnalyticsMetadata,
  type ExperimentalStorageReport,
} from "../src/data/admin-analytics-schema";
import { isAdminSession, resolveUserId, type IdentityEnv } from "./identity";

type AnalyticsEnv = IdentityEnv & {
  DB: Pick<D1Database, "prepare">;
  USER_OUTLINE: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): {
      getAnalyticsMetadata(): Promise<ClassicAnalyticsMetadata>;
    };
  };
  SHARD: ShardNamespaceLike;
};

type AdminSession = Parameters<typeof isAdminSession>[0];
const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

const Query = Schema.Struct({
  after: Schema.String.check(Schema.isMaxLength(200)),
  includeOwner: Schema.Literals(["true", "false"]),
});
const UserId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);
const UserRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateFromString,
  emailVerified: Schema.Literals([0, 1]),
  lastSessionCreatedAt: Schema.NullOr(Schema.DateFromString),
});

function json(
  value: AdminAnalyticsReport | ExperimentalStorageReport | { error: string },
  status = 200,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  });
}

/** Metadata failures mean unknown, never empty or opted-out. No content is logged. */
const classicMetadata = Effect.fn("AdminAnalytics.classicMetadata")(
  function* (env: AnalyticsEnv, userId: string) {
    const stub = env.USER_OUTLINE.get(
      env.USER_OUTLINE.idFromName(resolveUserId(userId, env)),
    );
    const raw = yield* Effect.tryPromise({
      try: () => stub.getAnalyticsMetadata(),
      catch: () => new Error("classic metadata unavailable"),
    });
    return yield* Schema.decodeUnknownEffect(ClassicAnalyticsMetadata)(raw);
  },
  Effect.timeout("3 seconds"),
  Effect.catch(() => Effect.succeed(null)),
);

const report = Effect.fn("AdminAnalytics.report")(function* (
  env: AnalyticsEnv,
  after: string,
  includeOwner: boolean,
  now: number,
) {
  const ownerId = env.OWNER_USER_ID ?? "";
  // Better Auth's D1 adapter stores canonical UTC ISO date strings.
  const through = new Date(now).toISOString();
  const since7d = new Date(now - 7 * DAY_MS).toISOString();
  const since30d = new Date(now - 30 * DAY_MS).toISOString();
  // Aggregate retained sessions BEFORE the join: multiple sessions cannot
  // multiply either the population or the count of recently authenticated users.
  const summaryRaw = yield* Effect.promise(() =>
    env.DB.prepare(`
    SELECT COUNT(*) AS registered,
      COALESCE(SUM(u.createdAt BETWEEN ? AND ?), 0) AS joined7d,
      COALESCE(SUM(u.createdAt BETWEEN ? AND ?), 0) AS joined30d,
      COALESCE(SUM(s.lastSessionCreatedAt BETWEEN ? AND ?), 0) AS retainedSession7d,
      COALESCE(SUM(s.lastSessionCreatedAt BETWEEN ? AND ?), 0) AS retainedSession30d
    FROM "user" u
    LEFT JOIN (SELECT userId, MAX(createdAt) AS lastSessionCreatedAt
      FROM "session" GROUP BY userId) s ON s.userId = u.id
    WHERE (? OR u.id <> ?)
  `)
      .bind(
        since7d,
        through,
        since30d,
        through,
        since7d,
        through,
        since30d,
        through,
        includeOwner ? 1 : 0,
        ownerId,
      )
      .first(),
  );
  const summary =
    yield* Schema.decodeUnknownEffect(AnalyticsSummary)(summaryRaw);
  const populationRaw = yield* Effect.promise(() =>
    env.DB.prepare('SELECT COUNT(*) AS n FROM "user"').first(),
  );
  const population = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ n: Schema.Number }),
  )(populationRaw);
  const page = yield* Effect.promise(() =>
    env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.createdAt, u.emailVerified,
      s.lastSessionCreatedAt
    FROM "user" u
    LEFT JOIN (SELECT userId, MAX(createdAt) AS lastSessionCreatedAt
      FROM "session" GROUP BY userId) s ON s.userId = u.id
    WHERE u.id > ? ORDER BY u.id LIMIT ?
  `)
      .bind(after, PAGE_SIZE + 1)
      .all(),
  );
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(UserRow))(
    page.results,
  );
  const visible = rows.slice(0, PAGE_SIZE);
  const users = yield* Effect.forEach(
    visible,
    (row) =>
      classicMetadata(env, row.id).pipe(
        Effect.map((metadata) => ({
          ...row,
          createdAt: row.createdAt.getTime(),
          lastSessionCreatedAt: row.lastSessionCreatedAt?.getTime() ?? null,
          emailVerified: row.emailVerified === 1,
          isOwner: row.id === ownerId,
          experimentalPreference: metadata?.experimentalPreference ?? "unknown",
          classicNodeCount: metadata?.nodeCount ?? null,
        })),
      ),
    { concurrency: 8 },
  );
  return yield* Schema.decodeUnknownEffect(AdminAnalyticsReport)({
    generatedAt: now,
    includeOwner,
    ownerConfigured: ownerId.length > 0,
    activityCoverage: "not-installed",
    population: population.n,
    summary,
    users,
    nextCursor: rows.length > PAGE_SIZE ? (visible.at(-1)?.id ?? null) : null,
  });
});

/** Auth precedes method/input/storage checks, including the per-user inspection. */
export const handleAdminAnalytics = Effect.fn("AdminAnalytics.handle")(
  function* (
    request: Request,
    env: AnalyticsEnv,
    session: AdminSession,
    now: number,
  ) {
    if (!isAdminSession(session, env)) return json({ error: "not found" }, 404);
    if (request.method !== "GET")
      return json({ error: "method not allowed" }, 405);
    const url = new URL(request.url);
    if (url.pathname === "/api/admin/analytics/storage") {
      const userId = Schema.decodeUnknownOption(UserId)(
        url.searchParams.get("userId"),
      );
      if (userId._tag === "None") return json({ error: "invalid userId" }, 400);
      // D1 is the authoritative population. Do not inspect arbitrary shard keys.
      const user = yield* Effect.promise(() =>
        env.DB.prepare('SELECT id FROM "user" WHERE id = ?')
          .bind(userId.value)
          .first(),
      );
      if (!user) return json({ error: "not found" }, 404);
      const metadata = yield* Effect.tryPromise({
        try: () =>
          createShardClient(env.SHARD)
            .asSystem()
            .forShard(userId.value)
            .call(internal.admin.outlineMetadata, { userId: userId.value }),
        catch: () => new Error("experimental metadata unavailable"),
      }).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(ExperimentalAnalyticsMetadata),
        ),
        Effect.timeout("3 seconds"),
        Effect.catch(() => Effect.succeed(null)),
      );
      return json({ userId: userId.value, checkedAt: now, metadata });
    }
    const query = Schema.decodeUnknownOption(Query)({
      after: url.searchParams.get("after") ?? "",
      includeOwner: url.searchParams.get("includeOwner") ?? "false",
    });
    if (query._tag === "None") return json({ error: "invalid query" }, 400);
    return json(
      yield* report(
        env,
        query.value.after,
        query.value.includeOwner === "true",
        now,
      ),
    );
  },
  Effect.catchTag("SchemaError", () =>
    Effect.die(new Error("Invalid admin analytics metadata")),
  ),
);
