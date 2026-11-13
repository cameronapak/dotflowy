import { Schema } from "effect";
import { useRef, useState } from "react";

import {
  FEEDBACK_REPLY_SUBJECT,
  feedbackReplyText,
  FeedbackTriage,
  type FeedbackInbox,
  type FeedbackReplyMode,
} from "../data/feedback-admin";
import { Button } from "./ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Textarea } from "./ui/textarea";

const REPLY_STATUS = {
  sending: "Awaiting email-service confirmation",
  accepted: "Accepted by email service",
  unknown: "Send unconfirmed, may have been sent",
  simulated: "Simulated, no email sent",
};

/** An explicit customer email, never an internal comment or automatic completion notice. */
export function FeedbackReply({
  entry,
  mode,
  onSaved,
  onDraftChange,
}: {
  entry: FeedbackInbox["submissions"][number];
  mode: FeedbackReplyMode;
  onSaved: (updated: FeedbackTriage, notice: string) => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [attempt, setAttempt] = useState<{
    id: string;
    message: string;
    recipientEmail: string;
  } | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const receipt = entry.replies.find((reply) => reply.id === attempt?.id);
  function reset() {
    setDraft("");
    setAttempt(null);
    setSubmitted(false);
    setError("");
    onDraftChange(false);
  }
  async function send() {
    if (!attempt || sending.current) return;
    sending.current = true;
    setBusy(true);
    setSubmitted(true);
    setError("");
    try {
      const response = await fetch("/api/admin/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          action: "reply",
          replyId: attempt.id,
          recipientEmail: attempt.recipientEmail,
          message: attempt.message,
        }),
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 409) {
        // A rejected claim did not send this draft. Refresh its recipient before a new attempt.
        setSubmitted(false);
        setAttempt(null);
        setError(
          "The recipient changed, isn't verified, or this send ID conflicts. Refresh the inbox before sending.",
        );
        return;
      }
      if (!response.ok) {
        setError(
          "Couldn't confirm the send. Your draft is kept. Check send status before starting another email.",
        );
        return;
      }
      const updated = Schema.decodeUnknownSync(FeedbackTriage)(
        await response.json(),
      );
      const saved = updated.replies.find((reply) => reply.id === attempt.id);
      if (updated.id !== entry.id || !saved) {
        setError(
          "Couldn't confirm the send. Check send status; don't start another email yet.",
        );
        return;
      }
      onDraftChange(false); // The attempt and message are now durable in the private history.
      onSaved(updated, REPLY_STATUS[saved.status]);
    } catch {
      setError(
        "Couldn't confirm the send. Your draft is kept. Check send status before starting another email.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-3" aria-label="Emails to reporter">
      <h2 className="text-sm font-medium">Emails to reporter</h2>
      {entry.replies.map((reply) => (
        <div
          key={reply.id}
          className="flex flex-col gap-1 border-l-2 border-border pl-3"
        >
          <p className="text-xs text-muted-foreground">
            {REPLY_STATUS[reply.status]} ·{" "}
            {new Date(reply.createdAt).toLocaleString()}
          </p>
          <p className="text-xs break-all text-muted-foreground">
            To: {reply.recipientEmail}
          </p>
          <p className="break-words whitespace-pre-wrap">{reply.message}</p>
          {(reply.status === "unknown" || reply.status === "sending") && (
            <p className="text-xs text-muted-foreground">
              Check your email-service logs before composing another email. This
              attempt will not be sent again.
            </p>
          )}
        </div>
      ))}
      {!open ? (
        <>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={mode === "disabled" || !entry.emailVerified}
            onClick={() => setOpen(true)}
          >
            Email reporter
          </Button>
          {mode === "disabled" && (
            <p className="text-xs text-muted-foreground">
              Sending is disabled until the Dotflowy support mailbox is verified
              and enabled.
            </p>
          )}
          {!entry.emailVerified && (
            <p className="text-xs text-muted-foreground">
              This account's email isn't verified. Email sending is unavailable.
            </p>
          )}
        </>
      ) : receipt ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm">
            {REPLY_STATUS[receipt.status]}.
            {receipt.status === "accepted" &&
              " This confirms acceptance, not delivery to their inbox."}
          </p>
          <div className="flex flex-wrap gap-2">
            {(receipt.status === "sending" || receipt.status === "unknown") && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void send()}
              >
                Check send status
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Close
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || receipt.status === "sending"}
              onClick={reset}
            >
              Write another email
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (!attempt) {
              const message = draft.trim();
              if (message)
                setAttempt({
                  id: crypto.randomUUID(),
                  message,
                  recipientEmail: entry.email,
                });
            } else void send();
          }}
        >
          <div className="flex flex-col gap-1 text-xs break-words text-muted-foreground">
            <p>From: Dotflowy Support &lt;support@dotflowy.com&gt;</p>
            <p className="break-all">
              To: {attempt?.recipientEmail ?? entry.email}
            </p>
            <p>Subject: {FEEDBACK_REPLY_SUBJECT}</p>
            <p>
              Customer replies go to support@dotflowy.com, not your personal
              address.
            </p>
          </div>
          {mode === "simulate" && (
            <p role="status" className="text-sm">
              Preview only. No email will be sent.
            </p>
          )}
          {attempt ? (
            <>
              <h3 className="text-sm font-medium">Review email</h3>
              <p
                data-testid="reply-review"
                className="break-words whitespace-pre-wrap"
              >
                {feedbackReplyText(attempt.message, entry.requestId)}
              </p>
              <p className="text-xs text-muted-foreground">
                Only this message, signature, and reference are emailed.
                Internal comments and the original report are not included.
              </p>
            </>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`reply-${entry.id}`}>
                  Your email to the reporter
                </FieldLabel>
                <Textarea
                  id={`reply-${entry.id}`}
                  maxLength={5000}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    onDraftChange(!!event.target.value.trim());
                  }}
                />
                <FieldDescription>
                  Up to 5,000 characters. Cam's signature and the report
                  reference are added automatically.
                </FieldDescription>
              </Field>
            </FieldGroup>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {attempt && !submitted && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAttempt(null)}
              >
                Edit email
              </Button>
            )}
            {!submitted && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  reset();
                  setOpen(false);
                }}
              >
                Discard draft
              </Button>
            )}
            <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
              {busy
                ? "Checking…"
                : !attempt
                  ? "Review email"
                  : submitted
                    ? "Check send status"
                    : mode === "simulate"
                      ? "Simulate email"
                      : "Send email"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
