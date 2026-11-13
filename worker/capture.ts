/// <reference types="@cloudflare/workers-types" />

import { Data, Effect, Schema } from "effect";

import type { CaptureResult } from "./capture-input";
import type { UserOutlineDO } from "./outline-do";

import { bareHttpUrl } from "../src/data/links";
import { parseMarkdownForest } from "../src/data/markdown-import";
import {
  CaptureBody,
  ApiKeyCreateBody,
  ApiKeyRotateBody,
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
  rotateCaptureKey,
} from "./capture-keys";
import { resolveUserId } from "./identity";
import { getPlan, nodeLimitForPlan } from "./plan";
import { rateLimitedTitleE } from "./unfurl";
import { unfurlTextE } from "./unfurl-text";

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

/** Who a capture belongs to, and how to recheck that they still may write. */
interface CaptureOwner {
  /** Better Auth `user.id`; the DO is keyed through `resolveUserId`. */
  userId: string;
  /** Rechecked before each background title upgrade, so a revoked key or an
   *  ended session cannot edit the outline after the response. */
  stillAuthorized: () => Promise<boolean>;
}

/** The authenticated half of capture: Markdown intake into one daily note,
 *  shared by capture keys (`/api/capture`) and the share target's signed-in
 *  page (`/api/share`). Callers authenticate and rate-limit first. */
const saveCapture = (
  request: Request,
  env: CaptureEnv,
  ctx: ExecutionContext,
  owner: CaptureOwner,
) =>
  Effect.gen(function* () {
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
    const [fingerprint, plan] = yield* Effect.all(
      [
        Effect.promise(() =>
          captureDigest(
            JSON.stringify([input.date, input.text, input.title ?? null]),
          ),
        ),
        Effect.promise(() => getPlan(owner.userId, env)),
      ],
      { concurrency: "unbounded" },
    );
    const stub = env.USER_OUTLINE.get(
      env.USER_OUTLINE.idFromName(resolveUserId(owner.userId, env)),
    );
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
    // Title lookup must never turn a committed save into a failure.
    if (!result.replayed) {
      ctx.waitUntil(
        Effect.runPromise(
          Effect.gen(function* () {
            // The planner mints ids in depth-first preorder, matching this
            // walk. Keep literal lines in the walk, but never enrich them.
            const stack = parseMarkdownForest(normalized.text).reverse();
            for (const nodeId of result.nodeIds) {
              const node = stack.pop()!;
              stack.push(...[...node.children].reverse());
              if (node.literal) continue;
              // A supplied title only labels a standalone URL, never prose.
              const before =
                input.title?.trim() && bareHttpUrl(input.text) ? node.text : "";
              const text = yield* unfurlTextE(before, node.text, (url) =>
                rateLimitedTitleE(
                  url,
                  env.UNFURL_LIMIT,
                  resolveUserId(owner.userId, env),
                ),
              );
              if (text === node.text) continue;
              if (!(yield* Effect.promise(owner.stillAuthorized))) return;
              yield* Effect.promise(() =>
                stub.upgradeCaptureText(attemptId, node.text, text, nodeId),
              );
            }
          }),
        ).catch(() => {
          console.warn("capture title lookup failed");
        }),
      );
    }
    return json({ ...result.receipt, replayed: result.replayed });
  });

/** Origins a signed-in browser request may come from: this server and its
 *  configured auth origins. */
function trustedOrigins(request: Request, env: CaptureEnv) {
  return new Set([
    new URL(request.url).origin,
    ...(env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : []),
    ...(env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",").map((origin) =>
      origin.trim(),
    ) ?? []),
  ]);
}

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
              "Capture key is invalid or expired. Create a replacement in Dotflowy Settings → Connections → API keys, then update the key in this shortcut's Text action.",
            ),
          );
        if (key.permission !== "capture" && key.permission !== "write")
          return yield* Effect.fail(
            fail(
              403,
              "insufficient_permission",
              "This key cannot capture. Create a Capture only key in Dotflowy Settings → Connections → API keys and update this shortcut.",
            ),
          );
        yield* rateLimit(env, `capture:${key.userId}`);
        const response = yield* saveCapture(request, env, ctx, {
          userId: key.userId,
          stillAuthorized: async () =>
            !!(await authenticateCaptureKey(env.DB, authorization, Date.now())),
        });
        // Metadata must never turn a committed save into a failure.
        ctx.waitUntil(
          env.DB.prepare("UPDATE capture_key SET lastUsedAt = ? WHERE id = ?")
            .bind(Date.now(), key.id)
            .run()
            .catch(() => {
              console.warn("capture last-used update failed");
            }),
        );
        return response;
      }),
    ),
);

/** The share target's Add to Today (ADR 0085). The caller has already
 *  validated the browser session; a capture key never reaches this route, and
 *  this route never accepts one. */
export const handleShareCapture = Effect.fn("Capture.share")(
  (
    request: Request,
    env: CaptureEnv,
    ctx: ExecutionContext,
    owner: CaptureOwner,
  ) =>
    respond(
      Effect.gen(function* () {
        if (request.method !== "POST")
          return json(
            { error: "method_not_allowed", message: "Use POST." },
            405,
          );
        if (
          !trustedOrigins(request, env).has(request.headers.get("origin") ?? "")
        )
          return yield* Effect.fail(
            fail(403, "invalid_origin", "Add shared items from Dotflowy."),
          );
        yield* rateLimit(env, `capture:${owner.userId}`);
        return yield* saveCapture(request, env, ctx, owner);
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
        if (
          request.method !== "POST" &&
          request.method !== "DELETE" &&
          !(
            request.method === "PATCH" &&
            new URL(request.url).pathname === "/api/keys"
          )
        )
          return json({ error: "method_not_allowed" }, 405);
        if (
          !trustedOrigins(request, env).has(request.headers.get("origin") ?? "")
        ) {
          return yield* Effect.fail(
            fail(
              403,
              "invalid_origin",
              "Open Dotflowy Settings on this server to manage API keys.",
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
              "Sign out and sign in again before creating or rotating an API key.",
            ),
          );
        }
        if (request.method === "PATCH") {
          const input = yield* decodeBody(request, ApiKeyRotateBody);
          const rotated = yield* Effect.promise(() =>
            rotateCaptureKey(env.DB, userId, input, Date.now()),
          );
          if (!rotated)
            return yield* Effect.fail(
              fail(
                404,
                "key_not_found",
                "This API key no longer exists. Create a new key.",
              ),
            );
          return json(rotated);
        }
        // The old capture-specific endpoint cannot mint broader credentials.
        const input = yield* decodeBody(
          request,
          new URL(request.url).pathname === "/api/capture-keys"
            ? CaptureKeyCreateBody
            : ApiKeyCreateBody,
        );
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
              "Sign in to your account before creating an API key.",
            ),
          );
        return json(created, 201);
      }),
    ),
);

/** What a share-sheet launch may carry: the manifest's three text fields, each
 *  within the capture body's own limit. The manifest declares no files, so a
 *  file under one of these names is refused and any other part is ignored. */
const ShareLaunchBody = Schema.Struct({
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
});

const shareRedirect = (fragment: string) =>
  new Response(null, {
    status: 303,
    headers: { location: `/share#${fragment}`, "cache-control": "no-store" },
  });

/** `POST /share`, the manifest's share_target action (ADR 0085). It saves
 *  nothing: it moves the shared fields into the `/share` page's URL fragment,
 *  which never reaches the server or its request logs, and the signed-in page
 *  saves only after the person taps Add to Today. A launch from the share
 *  sheet is browser-initiated or attributed to this app, so a form posted by
 *  another site (`cross-site`) or a sibling subdomain (`same-site`) is
 *  refused, as is a request without Fetch Metadata. */
export async function handleShareLaunch(
  request: Request,
  env: CaptureEnv,
): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (
    (site !== "none" && site !== "same-origin") ||
    (origin !== null &&
      origin !== "null" &&
      !trustedOrigins(request, env).has(origin))
  )
    return shareRedirect("error=rejected");
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !/^(multipart\/form-data|application\/x-www-form-urlencoded)(;|$)/i.test(
      contentType,
    )
  )
    return shareRedirect("error=invalid");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 131_072) return shareRedirect("error=invalid");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  }
  const form = await new Response(new Blob(chunks), {
    headers: { "content-type": contentType },
  })
    .formData()
    .catch(() => null);
  const decoded =
    form &&
    Schema.decodeUnknownOption(ShareLaunchBody)(Object.fromEntries(form));
  if (!decoded || decoded._tag === "None")
    return shareRedirect("error=invalid");
  const fields = Object.entries(decoded.value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return shareRedirect(new URLSearchParams(fields).toString());
}
