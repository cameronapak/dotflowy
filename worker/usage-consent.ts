/// <reference types="@cloudflare/workers-types" />

import { Effect, Schema } from "effect";

import {
  USAGE_POLICY_VERSION,
  UsageChoiceRequest,
  UsageConsentState,
  UsageDataExport,
  UsageDailyRow,
} from "../src/data/usage-consent-schema";

type UsageEnv = {
  DB: Pick<D1Database, "prepare" | "batch">;
  /** Publication acknowledgement, NOT an activity collection switch. */
  USAGE_NOTICE_VERSION?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
};

const ConsentRow = Schema.Struct({
  policyVersion: Schema.String,
  choice: Schema.Literals(["accepted", "declined"]),
  generation: Schema.String.check(Schema.isMinLength(1)),
  decidedAt: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
});

class UsageStorageError extends Schema.TaggedError<UsageStorageError>()(
  "UsageStorageError",
  {},
) {}

const readConsent = Effect.fn("UsageConsent.read")(function* (
  env: UsageEnv,
  userId: string,
) {
  const raw = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(
        "SELECT policyVersion, choice, generation, decidedAt FROM usage_consent WHERE userId = ?",
      )
        .bind(userId)
        .first(),
    catch: () => new UsageStorageError(),
  });
  return yield* Schema.decodeUnknownEffect(Schema.NullOr(ConsentRow))(raw);
});

/** Future collectors must capture BEFORE dispatching the authoritative write.
 * Failure means unmeasured, never a failed outline write. No producer is wired. */
export const captureUsageGeneration = Effect.fn("UsageConsent.capture")(
  function* (env: UsageEnv, userId: string) {
    if (env.USAGE_NOTICE_VERSION !== USAGE_POLICY_VERSION) return null;
    const consent = yield* readConsent(env, userId);
    return consent?.choice === "accepted" &&
      consent.policyVersion === USAGE_POLICY_VERSION
      ? consent.generation
      : null;
  },
  Effect.catch(() => Effect.succeed(null)),
);

const DAY_MS = 86_400_000;
export function oldestUsageDay(now: number): string {
  // Today and the preceding 89 UTC calendar days, not a sliding 90x24h window.
  return new Date(Math.floor(now / DAY_MS) * DAY_MS - 89 * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Storage fence for a future trusted after-commit producer. Never called by
 * browser input, cron, or either outline backend in this scaffold. The original
 * generation must survive retries; do not replace it with newly read consent. */
export const recordUsagePresence = Effect.fn("UsageConsent.recordPresence")(
  function* (
    env: UsageEnv,
    userId: string,
    generation: string,
    presence: typeof UsageDailyRow.Type,
    now: number,
  ) {
    if (env.USAGE_NOTICE_VERSION !== USAGE_POLICY_VERSION) return;
    yield* Effect.tryPromise({
      try: () =>
        env.DB.prepare(`
        INSERT INTO usage_daily (userId, day, backend, source, activity)
        SELECT c.userId, ?, ?, ?, ? FROM usage_consent c
        JOIN "user" u ON u.id = c.userId
        WHERE c.userId = ? AND c.choice = 'accepted'
          AND c.policyVersion = ? AND c.generation = ?
          AND ? BETWEEN ? AND ?
        ON CONFLICT (userId, day, backend, source, activity) DO NOTHING
      `)
          .bind(
            presence.day,
            presence.backend,
            presence.source,
            presence.activity,
            userId,
            USAGE_POLICY_VERSION,
            generation,
            presence.day,
            oldestUsageDay(now),
            new Date(now).toISOString().slice(0, 10),
          )
          .run(),
      catch: () => new UsageStorageError(),
    });
  },
);

export const purgeUsageSummaries = Effect.fn("UsageConsent.purge")(function* (
  env: Pick<UsageEnv, "DB">,
  now: number,
) {
  yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare("DELETE FROM usage_daily WHERE day < ?")
        .bind(oldestUsageDay(now))
        .run(),
    catch: () => new UsageStorageError(),
  });
});

function json(
  value: UsageConsentState | typeof UsageDataExport.Type | { error: string },
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

function trustedWriteOrigin(request: Request, env: UsageEnv): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site")
    return false;
  const allowed = new Set([
    new URL(request.url).origin,
    ...(env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()),
  ]);
  if (env.BETTER_AUTH_URL) allowed.add(new URL(env.BETTER_AUTH_URL).origin);
  return allowed.has(origin);
}

/** Caller supplies ONLY the validated server session's real auth ID, never the
 * owner-continuity DO ID or a request field. Account data remains outside sync. */
export const handleUsageConsent = Effect.fn("UsageConsent.handle")(
  function* (
    request: Request,
    env: UsageEnv,
    userId: string | null,
    now: number,
  ) {
    if (!userId) return json({ error: "unauthorized" }, 401);
    const path = new URL(request.url).pathname;
    if (path === "/api/usage/export") {
      if (request.method !== "GET")
        return json({ error: "method not allowed" }, 405);
      const consent = yield* readConsent(env, userId);
      const raw = yield* Effect.tryPromise({
        try: () =>
          env.DB.prepare(`SELECT day, backend, source, activity FROM usage_daily
          WHERE userId = ? AND day >= ? ORDER BY day, backend, source, activity`)
            .bind(userId, oldestUsageDay(now))
            .all(),
        catch: () => new UsageStorageError(),
      });
      const data = yield* Schema.decodeUnknownEffect(UsageDataExport)({
        consent: consent
          ? {
              policyVersion: consent.policyVersion,
              choice: consent.choice,
              decidedAt: consent.decidedAt,
            }
          : null,
        daily: raw.results,
      });
      return json(data);
    }
    if (path !== "/api/usage/consent") return json({ error: "not found" }, 404);
    if (request.method !== "GET" && request.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    if (request.method === "POST") {
      if (!trustedWriteOrigin(request, env))
        return json({ error: "forbidden origin" }, 403);
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      )
        return json({ error: "expected JSON" }, 415);
      const raw = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new UsageStorageError(),
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      const decoded = Schema.decodeUnknownOption(UsageChoiceRequest)(raw, {
        onExcessProperty: "error",
      });
      if (decoded._tag === "None")
        return json({ error: "invalid choice" }, 400);
      if (
        decoded.value.choice === "accepted" &&
        env.USAGE_NOTICE_VERSION !== USAGE_POLICY_VERSION
      )
        return json({ error: "notice not published" }, 409);
      // Fence and erasure are ONE D1 transaction. No window for late insertion.
      yield* Effect.tryPromise({
        try: () =>
          env.DB.batch([
            env.DB.prepare(`INSERT INTO usage_consent (userId, policyVersion, choice, generation, decidedAt)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId) DO UPDATE SET
              policyVersion = excluded.policyVersion, choice = excluded.choice,
              generation = excluded.generation, decidedAt = excluded.decidedAt`).bind(
              userId,
              USAGE_POLICY_VERSION,
              decoded.value.choice,
              crypto.randomUUID(),
              now,
            ),
            env.DB.prepare("DELETE FROM usage_daily WHERE userId = ?").bind(
              userId,
            ),
          ]),
        catch: () => new UsageStorageError(),
      });
    }
    const consent = yield* readConsent(env, userId);
    const current =
      consent?.policyVersion === USAGE_POLICY_VERSION ? consent : null;
    const state: UsageConsentState = {
      policyVersion: USAGE_POLICY_VERSION,
      choice: current?.choice ?? "unset",
      decidedAt: current?.decidedAt ?? null,
      noticeAvailable: env.USAGE_NOTICE_VERSION === USAGE_POLICY_VERSION,
      collectionInstalled: false,
    };
    return json(state);
  },
  Effect.catch(() =>
    Effect.succeed(json({ error: "usage settings unavailable" }, 503)),
  ),
);
