/// <reference types="@cloudflare/workers-types" />

import { Effect, Schema } from "effect";

import type { PlanName } from "../src/data/plans";

import { FeedbackSubmission } from "../src/data/feedback";
import {
  FeedbackAdminAction,
  FEEDBACK_REPLY_SUBJECT,
  feedbackReplyText,
  type FeedbackReply,
  type FeedbackReplyMode,
} from "../src/data/feedback-admin";
import { PLAN_LABELS } from "../src/data/plans";
import { sendEmail, type EmailEnv } from "./email";
import { isAdminSession } from "./identity";
import { getPlan } from "./plan";

export interface FeedbackEnv extends EmailEnv {
  DB: D1Database;
  ADMIN_USER_IDS?: string;
  ADMIN_EMAILS?: string;
  /** Notification destination only. Never used to authorize inbox access. */
  FEEDBACK_NOTIFICATION_EMAIL?: string;
  /** Fail closed until the support sender and receiving mailbox are verified. */
  FEEDBACK_REPLY_MODE?: string;
}

function replyMode(env: FeedbackEnv): FeedbackReplyMode {
  if (env.FEEDBACK_REPLY_MODE === "simulate") return "simulate";
  return env.FEEDBACK_REPLY_MODE === "send" && env.EMAIL ? "send" : "disabled";
}

const html = (text: string) =>
  `<div style="font-family:system-ui,sans-serif;max-width:32rem;line-height:1.6">${text
    .split("\n\n")
    .map(
      (paragraph) =>
        `<p>${paragraph.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</p>`,
    )
    .join("")}</div>`;

/** Send only for a newly inserted report, never a replay. Like invitations and
 * announcements, delivery is best-effort through the shared email seam. The D1
 * inbox is the durable receipt; a provider failure must not reject saved feedback.
 * Deliberately omit report text and diagnostics, including from local email logs.
 */
async function sendFeedbackEmails(
  env: FeedbackEnv,
  email: string,
  requestId: string,
  kind: FeedbackSubmission["kind"],
  plan: PlanName,
) {
  const text = `Thanks for taking the time to send ${kind === "idea" ? "an idea" : kind === "bug" ? "a bug report" : "a question"}. Your feedback is saved in Dotflowy's private inbox.

${plan === "free" ? "" : "Thank you for supporting Dotflowy.\n\n"}Ideas help shape Dotflowy, but aren't a promise of delivery. Urgent bugs come first on every plan.

Reference: ${requestId}

For privacy, your feedback text and technical details aren't included in this email. This is an automatic receipt, not a personal reply. If you need to follow up, email support@dotflowy.com with your reference.

Thank you,
Cam`;
  const sends = [
    sendEmail(env, {
      to: email,
      subject: "We received your Dotflowy feedback",
      text,
      html: html(text),
    }),
  ];
  if (env.FEEDBACK_NOTIFICATION_EMAIL) {
    const text = `New ${kind} feedback from a ${PLAN_LABELS[plan]} account.

Account email: ${email}

Reference: ${requestId}

Read the report in the private inbox: https://app.dotflowy.com/admin/feedback

Give subscriber ideas extra weight. Security, data loss, and urgent bugs come first on every plan. Report text and diagnostics stay in the inbox, not this email.`;
    sends.push(
      sendEmail(env, {
        to: env.FEEDBACK_NOTIFICATION_EMAIL,
        subject: `Dotflowy feedback: ${kind} (${PLAN_LABELS[plan]})`,
        text,
        html: `${html(text)}<p><a href="https://app.dotflowy.com/admin/feedback">Open private inbox</a></p>`,
      }),
    );
  } else {
    console.warn(
      "Feedback owner notification skipped: destination not configured",
    );
  }
  await Promise.all(sends);
}

export type FeedbackSession = { user: { id: string; email: string } } | null;

class FeedbackHttpError extends Schema.TaggedError<FeedbackHttpError>()(
  "FeedbackHttpError",
  { status: Schema.Number, error: Schema.String, message: Schema.String },
) {}

const fail = (status: number, error: string, message: string) =>
  new FeedbackHttpError({ status, error, message });

function json<T>(value: T, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

/** Do not preserve a D1 error/cause: bound SQL values can contain private text. */
const database = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      fail(
        503,
        "feedback_unavailable",
        "Feedback is temporarily unavailable. Retry this draft safely.",
      ),
  });

const respond = (program: Effect.Effect<Response, FeedbackHttpError>) =>
  program.pipe(
    Effect.catchTag("FeedbackHttpError", (error) =>
      Effect.succeed(
        json({ error: error.error, message: error.message }, error.status),
      ),
    ),
  );

const decodeBody = Effect.fn("Feedback.decode")(function* <A>(
  request: Request,
  schema: Schema.Decoder<A>,
) {
  if (
    !/^application\/json(?:;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    return yield* Effect.fail(fail(415, "invalid_content_type", "Send JSON."));
  // Bound actual streamed bytes, including chunked requests and unknown fields.
  const text = yield* Effect.tryPromise({
    try: async () => {
      const reader = request.body?.getReader();
      if (!reader) return "";
      const decoder = new TextDecoder();
      let length = 0;
      let text = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 32768)
            throw fail(413, "input_too_large", "Feedback input is too large.");
          text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
      } finally {
        await reader.cancel();
      }
    },
    catch: (error) =>
      error instanceof FeedbackHttpError
        ? error
        : fail(400, "invalid_body", "Couldn't read the request."),
  });
  const raw = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: () => fail(400, "invalid_body", "Send valid JSON."),
  });
  return yield* Schema.decodeUnknownEffect(schema, {
    onExcessProperty: "error",
  })(raw).pipe(
    Effect.mapError(() =>
      fail(400, "invalid_input", "Check the feedback fields and try again."),
    ),
  );
});

/** POST /api/feedback. Caller owns same-origin/CSRF checks and session lookup.
 * Pass the unmodified server session, NOT resolveUserId's outline DO key.
 * Expected failures are already mapped; unexpected defects reach the caller.
 */
export const handleFeedbackRequest = Effect.fn("Feedback.request")(
  (
    request: Request,
    env: FeedbackEnv,
    session: FeedbackSession,
    executionCtx: Pick<ExecutionContext, "waitUntil">,
  ) =>
    respond(
      Effect.gen(function* () {
        if (!session) return json({ error: "unauthorized" }, 401);
        if (request.method !== "POST")
          return json({ error: "method_not_allowed" }, 405);
        const input = yield* decodeBody(request, FeedbackSubmission);
        const userId = session.user.id;
        // Canonical key order means JSON whitespace/key order does not affect retries.
        const canonical = JSON.stringify({
          kind: input.kind,
          message: input.message,
          appVersion: input.context.appVersion,
          browser: input.context.browser ?? null,
          routeCategory: input.context.routeCategory ?? null,
        });
        const digest = yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
        );
        const hash = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const existing = () =>
          database(() =>
            env.DB.prepare(
              "SELECT payload_hash FROM feedback_submissions WHERE user_id = ? AND request_id = ?",
            )
              .bind(userId, input.id)
              .first<{ payload_hash: string }>(),
          );
        const replay = (stored: { payload_hash: string }) =>
          stored.payload_hash === hash
            ? Effect.succeed(json({ id: input.id, replayed: true }))
            : Effect.fail(
                fail(
                  409,
                  "idempotency_conflict",
                  "This attempt was already used for different feedback.",
                ),
              );
        const prior = yield* existing();
        // Confirm already-sent paid feedback even after a downgrade, without re-tagging it.
        if (prior) return yield* replay(prior);
        const plan = yield* database(() => getPlan(userId, env));
        if (input.kind !== "bug" && plan !== "unlimited" && plan !== "founding")
          return yield* Effect.fail(
            fail(
              403,
              "membership_required",
              "Ideas and questions require Pro or Founding.",
            ),
          );
        // One SQLite statement makes count+insert atomic under concurrent requests.
        // Ten accepted submissions per rolling 24h; retries never consume quota.
        const now = Date.now();
        const result = yield* database(() =>
          env.DB.prepare(`
        INSERT INTO feedback_submissions
          (user_id, request_id, payload_hash, plan, kind, message, app_version, browser, route_category, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
        WHERE (SELECT COUNT(*) FROM feedback_submissions WHERE user_id = ?1 AND created_at > ?11) < 10
        ON CONFLICT(user_id, request_id) DO NOTHING
      `)
            .bind(
              userId,
              input.id,
              hash,
              plan,
              input.kind,
              input.message,
              input.context.appVersion,
              input.context.browser ?? null,
              input.context.routeCategory ?? null,
              now,
              now - 86400000,
            )
            .run(),
        );
        if (result.meta.changes > 0) {
          executionCtx.waitUntil(
            sendFeedbackEmails(
              env,
              session.user.email,
              input.id,
              input.kind,
              plan,
            ),
          );
          return json({ id: input.id, replayed: false }, 201);
        }
        // A concurrent duplicate (even at quota) must return its original receipt.
        const concurrent = yield* existing();
        if (concurrent) return yield* replay(concurrent);
        return yield* Effect.fail(
          fail(
            429,
            "rate_limited",
            "Feedback limit reached. Wait 24 hours and retry.",
          ),
        );
      }),
    ),
);

// One query for all visible reports, rather than a D1 query per card.
const readComments = (db: D1Database, ids: readonly number[]) =>
  database(() =>
    db
      .prepare(`
      SELECT id, submission_id AS submissionId, message, created_at AS createdAt
      FROM feedback_comments WHERE submission_id IN (SELECT value FROM json_each(?))
      ORDER BY created_at, id
    `)
      .bind(JSON.stringify(ids))
      .all<{
        id: string;
        submissionId: number;
        message: string;
        createdAt: number;
      }>(),
  );

const readReplies = (db: D1Database, ids: readonly number[]) =>
  database(() =>
    db
      .prepare(`
    SELECT id, submission_id AS submissionId, recipient_email AS recipientEmail,
      message, created_at AS createdAt,
      CASE WHEN status = 'sending' AND created_at < ?2 THEN 'unknown' ELSE status END AS status
    FROM feedback_replies WHERE submission_id IN (SELECT value FROM json_each(?1))
    ORDER BY created_at, id
  `)
      .bind(JSON.stringify(ids), Date.now() - 120_000)
      .all<FeedbackReply & { submissionId: number }>(),
  );

const replyToFeedback = Effect.fn("Feedback.reply")(function* (
  input: Extract<FeedbackAdminAction, { action: "reply" }>,
  env: FeedbackEnv,
  authorId: string,
  executionCtx: Pick<ExecutionContext, "waitUntil">,
) {
  const prior = () =>
    database(() =>
      env.DB.prepare(
        "SELECT submission_id, author_id, recipient_email, message FROM feedback_replies WHERE id = ?",
      )
        .bind(input.replyId)
        .first<{
          submission_id: number;
          author_id: string;
          recipient_email: string;
          message: string;
        }>(),
    );
  // The SELECT/INSERT race is resolved by the unique send ID, not an in-memory lock.
  let existing = yield* prior();
  if (!existing) {
    const mode = replyMode(env);
    if (mode === "disabled")
      return yield* Effect.fail(
        fail(503, "email_disabled", "Reply email is not enabled."),
      );
    const now = Date.now();
    const claim = yield* database(() =>
      env.DB.prepare(`
        INSERT INTO feedback_replies
          (id, submission_id, author_id, recipient_email, message, status, created_at, updated_at)
        SELECT ?1, f.id, ?2, u.email, ?3, ?4, ?5, ?5
        FROM feedback_submissions f JOIN "user" u ON u.id = f.user_id
        WHERE f.id = ?6 AND u.email = ?7 AND u.emailVerified = 1
        ON CONFLICT(id) DO NOTHING
      `)
        .bind(
          input.replyId,
          authorId,
          input.message,
          mode === "simulate" ? "simulated" : "sending",
          now,
          input.id,
          input.recipientEmail,
        )
        .run(),
    );
    if (claim.meta.changes > 0) {
      if (mode === "simulate") return;
      const report = yield* database(() =>
        env.DB.prepare(
          "SELECT request_id FROM feedback_submissions WHERE id = ?",
        )
          .bind(input.id)
          .first<{ request_id: string }>(),
      );
      if (!report) return;
      const text = feedbackReplyText(input.message, report.request_id);
      const delivery = Effect.runPromise(
        Effect.gen(function* () {
          const outcome = yield* Effect.promise(() =>
            sendEmail(env, {
              sender: "support",
              to: input.recipientEmail,
              subject: FEEDBACK_REPLY_SUBJECT,
              text,
              html: html(text),
            }),
          );
          yield* database(() =>
            env.DB.prepare(
              "UPDATE feedback_replies SET status = ?, provider_message_id = ?, updated_at = ? WHERE id = ?",
            )
              .bind(
                outcome.status === "accepted" ? "accepted" : "unknown",
                outcome.status === "accepted" ? outcome.messageId : null,
                Date.now(),
                input.replyId,
              )
              .run(),
          );
        }).pipe(
          Effect.catchTag("FeedbackHttpError", () =>
            Effect.sync(() => {
              console.error(
                "Feedback reply status could not be saved; this send will not be repeated.",
              );
            }),
          ),
        ),
      );
      executionCtx.waitUntil(delivery);
      yield* Effect.promise(() => delivery);
      return;
    }
    existing = yield* prior();
  }
  if (
    !existing ||
    existing.submission_id !== input.id ||
    existing.author_id !== authorId ||
    existing.recipient_email !== input.recipientEmail ||
    existing.message !== input.message
  )
    return yield* Effect.fail(
      fail(
        409,
        "reply_conflict",
        "Refresh the report: the recipient changed, isn't verified, or this send ID was already used.",
      ),
    );
  // Never resend an existing attempt, including unknown provider outcomes.
});

/** GET/POST /api/admin/feedback. All triage stays behind the existing admin
 * policy, including comments. Hidden with 404 before validating any input.
 * GET is newest first, default 50, maximum 100. No customer read endpoint.
 * Internal comments never send email; only the explicit reply action does.
 */
export const handleFeedbackInboxRequest = Effect.fn("Feedback.inbox")(
  (
    request: Request,
    env: FeedbackEnv,
    session: FeedbackSession,
    executionCtx: Pick<ExecutionContext, "waitUntil">,
  ) =>
    respond(
      Effect.gen(function* () {
        if (!session || !isAdminSession(session, env))
          return json({ error: "not_found" }, 404);
        if (request.method === "POST") {
          if (
            request.headers.has("origin") &&
            request.headers.get("origin") !== new URL(request.url).origin
          )
            return json({ error: "invalid_origin" }, 403);
          const input = yield* decodeBody(request, FeedbackAdminAction);
          const report = yield* database(() =>
            env.DB.prepare("SELECT id FROM feedback_submissions WHERE id = ?")
              .bind(input.id)
              .first<{ id: number }>(),
          );
          if (!report) return json({ error: "not_found" }, 404);
          if (input.action === "reply") {
            yield* replyToFeedback(input, env, session.user.id, executionCtx);
          } else if (input.action === "comment") {
            // Stable comment IDs make an uncertain HTTP response safe to retry.
            yield* database(() =>
              env.DB.prepare(`
                INSERT INTO feedback_comments (id, submission_id, author_id, message, created_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
              `)
                .bind(
                  input.commentId,
                  input.id,
                  session.user.id,
                  input.message,
                  Date.now(),
                )
                .run(),
            );
            const saved = yield* database(() =>
              env.DB.prepare(
                "SELECT submission_id, author_id, message FROM feedback_comments WHERE id = ?",
              )
                .bind(input.commentId)
                .first<{
                  submission_id: number;
                  author_id: string;
                  message: string;
                }>(),
            );
            if (
              saved?.submission_id !== input.id ||
              saved.author_id !== session.user.id ||
              saved.message !== input.message
            )
              return yield* Effect.fail(
                fail(
                  409,
                  "idempotency_conflict",
                  "This attempt already saved a different comment.",
                ),
              );
          } else {
            yield* database(() =>
              env.DB.prepare(
                input.action === "complete"
                  ? "UPDATE feedback_submissions SET completed_at = COALESCE(completed_at, ?) WHERE id = ?"
                  : "UPDATE feedback_submissions SET completed_at = NULL WHERE id = ?",
              )
                .bind(
                  ...(input.action === "complete"
                    ? [Date.now(), input.id]
                    : [input.id]),
                )
                .run(),
            );
          }
          const updated = yield* database(() =>
            env.DB.prepare(
              "SELECT id, completed_at AS completedAt FROM feedback_submissions WHERE id = ?",
            )
              .bind(input.id)
              .first<{ id: number; completedAt: number | null }>(),
          );
          if (!updated) return json({ error: "not_found" }, 404);
          const comments = yield* readComments(env.DB, [input.id]);
          const replies = yield* readReplies(env.DB, [input.id]);
          return json({
            ...updated,
            replies: replies.results.map(
              ({ submissionId: _submissionId, ...reply }) => reply,
            ),
            comments: comments.results.map(({ id, message, createdAt }) => ({
              id,
              message,
              createdAt,
            })),
          });
        }
        if (request.method !== "GET")
          return json({ error: "method_not_allowed" }, 405);
        const params = new URL(request.url).searchParams;
        const kind = params.get("kind");
        const plan = params.get("plan");
        const status = params.get("status");
        const limit = Number(params.get("limit") ?? 50);
        if (
          (kind !== null && !["bug", "idea", "question"].includes(kind)) ||
          (plan !== null &&
            !["free", "unlimited", "founding"].includes(plan)) ||
          (status !== null && !["open", "complete"].includes(status)) ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          return yield* Effect.fail(
            fail(
              400,
              "invalid_query",
              "Use a valid kind, plan, status and limit (1–100).",
            ),
          );
        const rows = yield* database(() =>
          env.DB.prepare(`
        SELECT f.id, f.user_id AS userId, f.request_id AS requestId, f.plan, f.kind, f.message,
          f.app_version AS appVersion, f.browser, f.route_category AS routeCategory, f.created_at AS createdAt,
          f.completed_at AS completedAt, u.email, u.emailVerified
        FROM feedback_submissions f JOIN "user" u ON u.id = f.user_id
        WHERE (?1 IS NULL OR f.kind = ?1) AND (?2 IS NULL OR f.plan = ?2)
          AND (?3 IS NULL OR (?3 = 'open' AND f.completed_at IS NULL) OR (?3 = 'complete' AND f.completed_at IS NOT NULL))
        ORDER BY f.created_at DESC, f.id DESC LIMIT ?4
      `)
            .bind(kind, plan, status, limit)
            .all<{ id: number; emailVerified: number }>(),
        );
        const comments = yield* readComments(
          env.DB,
          rows.results.map((row) => row.id),
        );
        const replies = yield* readReplies(
          env.DB,
          rows.results.map((row) => row.id),
        );
        return json({
          replyMode: replyMode(env),
          submissions: rows.results.map((row) => ({
            ...row,
            emailVerified: row.emailVerified === 1,
            replies: replies.results
              .filter((reply) => reply.submissionId === row.id)
              .map(({ submissionId: _submissionId, ...reply }) => reply),
            comments: comments.results
              .filter((comment) => comment.submissionId === row.id)
              .map(({ id, message, createdAt }) => ({
                id,
                message,
                createdAt,
              })),
          })),
        });
      }),
    ),
);
