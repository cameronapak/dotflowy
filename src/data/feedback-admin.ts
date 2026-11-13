import { Schema } from "effect";

import { FeedbackKind, FeedbackSubmission } from "./feedback";

export const FeedbackReplyMode = Schema.Literals([
  "disabled",
  "simulate",
  "send",
]);
export type FeedbackReplyMode = typeof FeedbackReplyMode.Type;

export const FeedbackReply = Schema.Struct({
  id: Schema.String,
  recipientEmail: Schema.String,
  message: Schema.String,
  status: Schema.Literals(["sending", "accepted", "unknown", "simulated"]),
  createdAt: Schema.Number,
});
export type FeedbackReply = typeof FeedbackReply.Type;

export const FEEDBACK_REPLY_SUBJECT = "An update on your Dotflowy feedback";
export function feedbackReplyText(message: string, reference: string) {
  return `${message}\n\nCam\nDotflowy\n\nFeedback reference: ${reference}`;
}

/** Admin-only contracts. Never include these fields in customer receipts. */
export const FeedbackTriage = Schema.Struct({
  id: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  replies: Schema.Array(FeedbackReply),
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      message: Schema.String,
      createdAt: Schema.Number,
    }),
  ),
});
export type FeedbackTriage = typeof FeedbackTriage.Type;

export const FeedbackInbox = Schema.Struct({
  replyMode: FeedbackReplyMode,
  submissions: Schema.Array(
    Schema.Struct({
      ...FeedbackTriage.fields,
      userId: Schema.String,
      email: Schema.String,
      emailVerified: Schema.Boolean,
      requestId: Schema.String,
      plan: Schema.Literals(["free", "unlimited", "founding"]),
      kind: FeedbackKind,
      message: Schema.String,
      appVersion: Schema.String,
      browser: Schema.NullOr(Schema.String),
      routeCategory: Schema.NullOr(Schema.String),
      createdAt: Schema.Number,
    }),
  ),
});
export type FeedbackInbox = typeof FeedbackInbox.Type;

const ReportId = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
export const FeedbackAdminAction = Schema.Union([
  Schema.Struct({
    id: ReportId,
    action: Schema.Literals(["complete", "reopen"]),
  }),
  Schema.Struct({
    id: ReportId,
    action: Schema.Literal("comment"),
    commentId: FeedbackSubmission.fields.id,
    message: FeedbackSubmission.fields.message,
  }),
  Schema.Struct({
    id: ReportId,
    action: Schema.Literal("reply"),
    replyId: FeedbackSubmission.fields.id,
    recipientEmail: Schema.String.check(Schema.isMaxLength(254)),
    message: FeedbackSubmission.fields.message,
  }),
]);
export type FeedbackAdminAction = typeof FeedbackAdminAction.Type;
