/// <reference types="@cloudflare/workers-types" />

import { Data, Effect, Schema } from "effect";

import type { CaptureResult } from "./capture-input";
import type { UserOutlineDO } from "./outline-do";

import { encodeUrlForMarkdown, sanitizeLinkLabel } from "../src/data/links";
import {
  CaptureBody,
  CaptureKeyCreateBody,
  CaptureKeyRevokeBody,
  captureDigest,
  normalizeCapture,
} from "./capture-input";
import {
  authenticateCaptureKey,
  createCaptureKey,
  listCaptureKeys,
  revokeCaptureKeys,
} from "./capture-keys";
import { resolveUserId } from "./identity";
import { getPlan, nodeLimitForPlan } from "./plan";
import { unfurlTitleE } from "./unfurl";

interface CaptureEnv {
  DB: D1Database;
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>;
  OWNER_USER_ID?: string;
  CAPTURE_LIMIT: RateLimit;
  UNFURL_LIMIT: RateLimit;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
}

class CaptureHttpError extends Data.TaggedError("CaptureHttpError")<{
  status: number;
  error: string;
  message: string;
}> {}

const fail = (status: number, error: string, message: string) =>
  new CaptureHttpError({ status, error, message });

function json<T>(value: T, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** Bound streamed bodies too; Content-Length alone is not a size guarantee. */
const decodeBody = <S extends Schema.Top>(request: Request, schema: S) =>
  Effect.gen(function* () {
    if (
      !/^application\/json(?:;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    ) {
      return yield* Effect.fail(
        fail(415, "invalid_content_type", "Send JSON."),
      );
    }
    const text = yield* Effect.tryPromise({
      try: async () => {
        const reader = request.body?.getReader();
        if (!reader) return "";
        let length = 0;
        let text = "";
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 65_536)
              throw fail(413, "input_too_large", "Capture input is too large.");
            text += decoder.decode(value, { stream: true });
          }
          return text + decoder.decode();
        } finally {
          await reader.cancel();
        }
      },
      catch: (error) =>
        error instanceof CaptureHttpError
          ? error
          : fail(400, "invalid_body", "Couldn't read the request."),
    });
    const raw = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => fail(400, "invalid_body", "Send a valid JSON body."),
    });
    return yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError(() =>
        fail(400, "invalid_input", "Check the capture input and try again."),
      ),
    );
  });

const rateLimit = Effect.fn("Capture.rateLimit")(function* (
  env: CaptureEnv,
  key: string,
) {
  const { success } = yield* Effect.promise(() =>
    env.CAPTURE_LIMIT.limit({ key }),
  );
  if (!success)
    return yield* Effect.fail(
      fail(
        429,
        "rate_limited",
        "Too many requests. Wait a minute, then retry the same attempt.",
      ),
    );
});

const respond = <R>(program: Effect.Effect<Response, CaptureHttpError, R>) =>
  program.pipe(
    Effect.catchTag("CaptureHttpError", (error) =>
      Effect.succeed(
        json(
          {
            error: error.error,
            message: error.message,
          },
          error.status,
        ),
      ),
    ),
  );

export const handleCaptureRequest = Effect.fn("Capture.request")(
  (request: Request, env: CaptureEnv, ctx: ExecutionContext) =>
    respond(
      Effect.gen(function* () {
        if (request.method !== "POST")
          return json(
            { error: "method_not_allowed", message: "Use POST." },
            405,
          );
        const authorization = request.headers.get("authorization");
        const key = yield* Effect.promise(() =>
          authenticateCaptureKey(env.DB, authorization, Date.now()),
        );
        if (!key)
          return yield* Effect.fail(
            fail(
              401,
              "invalid_key",
              "Capture key is invalid or expired. Create a replacement in Settings and update this shortcut.",
            ),
          );
        yield* rateLimit(env, `capture:${key.userId}`);
        const input = yield* decodeBody(request, CaptureBody);
        const normalized = normalizeCapture(input);
        if (!normalized)
          return yield* Effect.fail(
            fail(
              400,
              "invalid_input",
              "Use a real calendar date and nonblank text.",
            ),
          );
        const attemptId = input.attemptId.toLowerCase();
        const fingerprint = yield* Effect.promise(() =>
          captureDigest(
            JSON.stringify([input.date, input.text, input.title ?? null]),
          ),
        );
        const stub = env.USER_OUTLINE.get(
          env.USER_OUTLINE.idFromName(resolveUserId(key.userId, env)),
        );
        const plan = yield* Effect.promise(() => getPlan(key.userId, env));
        const result = yield* Effect.promise<CaptureResult>(() =>
          stub.captureDaily(
            {
              attemptId,
              date: input.date,
              text: normalized.text,
              fingerprint,
            },
            nodeLimitForPlan(plan),
          ),
        );
        if ("error" in result) {
          return yield* Effect.fail(
            result.error === "node_limit"
              ? fail(
                  403,
                  "node_limit",
                  "Your outline has reached its node limit. Remove nodes or upgrade, then retry the same attempt.",
                )
              : fail(
                  409,
                  "attempt_conflict",
                  "This attempt ID belongs to a different capture. Start a new attempt.",
                ),
          );
        }
        // Metadata and title lookup must never turn a committed save into a failure.
        ctx.waitUntil(
          env.DB.prepare("UPDATE capture_key SET lastUsedAt = ? WHERE id = ?")
            .bind(Date.now(), key.id)
            .run()
            .catch(() => {
              console.warn("capture last-used update failed");
            }),
        );
        const url = normalized.unfurlUrl;
        if (url && !result.replayed) {
          ctx.waitUntil(
            Effect.runPromise(
              Effect.gen(function* () {
                const { success } = yield* Effect.promise(() =>
                  env.UNFURL_LIMIT.limit({
                    key: resolveUserId(key.userId, env),
                  }),
                );
                if (!success) return;
                const title = yield* unfurlTitleE(url);
                const label = title ? sanitizeLinkLabel(title) : "";
                if (!label) return;
                const liveKey = yield* Effect.promise(() =>
                  authenticateCaptureKey(env.DB, authorization, Date.now()),
                );
                if (!liveKey) return;
                yield* Effect.promise(() =>
                  stub.upgradeCaptureText(
                    attemptId,
                    normalized.text,
                    `[${label}](${encodeUrlForMarkdown(url)})`,
                  ),
                );
              }),
            ).catch(() => {
              console.warn("capture title lookup failed");
            }),
          );
        }
        return json({ ...result.receipt, replayed: result.replayed });
      }),
    ),
);

export const handleCaptureKeys = Effect.fn("Capture.keys")(
  (request: Request, env: CaptureEnv, userId: string, sessionCreatedAt: Date) =>
    respond(
      Effect.gen(function* () {
        if (request.method === "GET")
          return json({
            keys: yield* Effect.promise(() => listCaptureKeys(env.DB, userId)),
          });
        if (request.method !== "POST" && request.method !== "DELETE")
          return json({ error: "method_not_allowed" }, 405);
        const origins = new Set([
          new URL(request.url).origin,
          ...(env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : []),
          ...(env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",").map((origin) =>
            origin.trim(),
          ) ?? []),
        ]);
        if (!origins.has(request.headers.get("origin") ?? "")) {
          return yield* Effect.fail(
            fail(
              403,
              "invalid_origin",
              "Open Settings on this Dotflowy server to manage keys.",
            ),
          );
        }
        yield* rateLimit(env, `manage:${userId}`);
        if (request.method === "DELETE") {
          const input = yield* decodeBody(request, CaptureKeyRevokeBody);
          yield* Effect.promise(() =>
            revokeCaptureKeys(env.DB, userId, input.id),
          );
          return json({ revoked: true });
        }
        if (Date.now() - sessionCreatedAt.getTime() >= 86_400_000) {
          return yield* Effect.fail(
            fail(
              401,
              "fresh_session_required",
              "Sign out and sign in again before creating a capture key.",
            ),
          );
        }
        const input = yield* decodeBody(request, CaptureKeyCreateBody);
        if (!input.name.trim())
          return yield* Effect.fail(
            fail(400, "invalid_name", "Give the key a name."),
          );
        const created = yield* Effect.promise(() =>
          createCaptureKey(env.DB, userId, input, Date.now()),
        );
        if (!created)
          return yield* Effect.fail(
            fail(
              403,
              "credential_required",
              "Sign in to your account before creating a capture key.",
            ),
          );
        return json(created, 201);
      }),
    ),
);
