import { createFileRoute, Link } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { FeedbackReply } from "../components/feedback-reply";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "../components/ui/native-select";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import {
  FeedbackInbox as Inbox,
  FeedbackTriage,
  type FeedbackAdminAction,
} from "../data/feedback-admin";
import { PLAN_LABELS } from "../data/plans";

function FeedbackCard({
  entry,
  mode,
  onSaved,
}: {
  entry: Inbox["submissions"][number];
  mode: Inbox["replyMode"];
  onSaved: (updated: FeedbackTriage, notice: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [hasReplyDraft, setHasReplyDraft] = useState(false);
  const [busy, setBusy] = useState<FeedbackAdminAction["action"] | null>(null);
  const [error, setError] = useState("");
  const attempt = useRef<{ message: string; id: string } | null>(null);
  const saving = useRef(false);
  async function save(action: FeedbackAdminAction) {
    if (saving.current) return;
    saving.current = true;
    setBusy(action.action);
    setError("");
    const failure =
      "Couldn't confirm the save. Your draft is here; retry safely. If access changed, sign in again.";
    try {
      const response = await fetch("/api/admin/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        setError(failure);
        return;
      }
      const updated = Schema.decodeUnknownSync(FeedbackTriage)(
        await response.json(),
      );
      if (updated.id !== entry.id) {
        setError(failure);
        return;
      }
      if (action.action === "comment") {
        setDraft("");
        attempt.current = null;
      }
      onSaved(
        updated,
        action.action === "comment"
          ? "Internal comment saved."
          : action.action === "complete"
            ? "Report marked complete."
            : "Report reopened.",
      );
    } catch {
      setError(failure);
    } finally {
      saving.current = false;
      setBusy(null);
    }
  }
  return (
    <Card data-testid="feedback-report">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="capitalize">{entry.kind}</span>
            <Badge variant="secondary">{PLAN_LABELS[entry.plan]}</Badge>
            <Badge
              variant={entry.completedAt === null ? "outline" : "secondary"}
            >
              {entry.completedAt === null ? "Open" : "Complete"}
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !!draft.trim() || hasReplyDraft}
            aria-describedby={
              hasReplyDraft
                ? `reply-help-${entry.id}`
                : draft.trim()
                  ? `comment-help-${entry.id}`
                  : undefined
            }
            onClick={() =>
              void save({
                id: entry.id,
                action: entry.completedAt === null ? "complete" : "reopen",
              })
            }
          >
            {busy === "complete" || busy === "reopen"
              ? "Saving…"
              : entry.completedAt === null
                ? "Mark complete"
                : "Reopen"}
          </Button>
        </div>
        <CardDescription>
          {new Date(entry.createdAt).toLocaleString()} ·{" "}
          <a
            className="break-all underline underline-offset-4"
            href={`mailto:${encodeURIComponent(entry.email)}`}
          >
            {entry.email}
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="break-words whitespace-pre-wrap">{entry.message}</p>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p className="break-all">Reference: {entry.requestId}</p>
          <p className="break-all">Account: {entry.userId}</p>
          <p>
            App {entry.appVersion}
            {entry.routeCategory ? ` · ${entry.routeCategory}` : ""}
          </p>
          {entry.browser && <p className="break-words">{entry.browser}</p>}
          {entry.completedAt !== null && (
            <p>Completed {new Date(entry.completedAt).toLocaleString()}</p>
          )}
        </div>
        <Separator />
        <FeedbackReply
          entry={entry}
          mode={mode}
          onSaved={onSaved}
          onDraftChange={setHasReplyDraft}
        />
        {hasReplyDraft && (
          <p
            id={`reply-help-${entry.id}`}
            className="text-xs text-muted-foreground"
          >
            Finish or discard your email draft before changing this report's
            status.
          </p>
        )}
        <Separator />
        <section className="flex flex-col gap-3" aria-label="Internal comments">
          <h2 className="text-sm font-medium">Internal comments</h2>
          <p className="text-xs text-muted-foreground">
            Only visible in this private admin inbox. Not sent to the reporter.
          </p>
          {entry.comments.map((comment) => (
            <div
              key={comment.id}
              className="flex flex-col gap-1 border-l-2 border-border pl-3"
            >
              <time
                className="text-xs text-muted-foreground"
                dateTime={new Date(comment.createdAt).toISOString()}
              >
                {new Date(comment.createdAt).toLocaleString()}
              </time>
              <p className="break-words whitespace-pre-wrap">
                {comment.message}
              </p>
            </div>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const message = draft.trim();
              if (!message || busy) return;
              if (attempt.current?.message !== message)
                attempt.current = { id: crypto.randomUUID(), message };
              void save({
                id: entry.id,
                action: "comment",
                commentId: attempt.current.id,
                message,
              });
            }}
          >
            <FieldGroup>
              <Field data-disabled={busy !== null}>
                <FieldLabel htmlFor={`comment-${entry.id}`}>
                  Add an internal comment
                </FieldLabel>
                <Textarea
                  id={`comment-${entry.id}`}
                  value={draft}
                  maxLength={5000}
                  disabled={busy !== null}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <FieldDescription id={`comment-help-${entry.id}`}>
                  Up to 5,000 characters.
                  {draft.trim() &&
                    " Save or clear your draft before changing the report's status."}
                </FieldDescription>
              </Field>
              <Button
                type="submit"
                size="sm"
                className="self-start"
                disabled={busy !== null || !draft.trim()}
              >
                {busy === "comment" ? "Saving…" : "Save internal comment"}
              </Button>
            </FieldGroup>
          </form>
        </section>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/admin/feedback")({
  component: FeedbackInbox,
});

// Deliberately unlinked from customer chrome, like the other admin views.
// The API owns authorization and never exposes submissions to other users.
function FeedbackInbox() {
  const [kind, setKind] = useState("");
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("open");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<typeof Inbox.Type | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">(
    "loading",
  );
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "100" });
    if (kind) params.set("kind", kind);
    if (plan) params.set("plan", plan);
    if (status) params.set("status", status);
    fetch(`/api/admin/feedback?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          if (!controller.signal.aborted)
            setState(
              response.status === 404 || response.status === 401
                ? "denied"
                : "error",
            );
          return;
        }
        const data = Schema.decodeUnknownSync(Inbox)(await response.json());
        if (!controller.signal.aborted) {
          setResult(data);
          setState("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [kind, plan, status, revision]);
  if (state === "denied") return <main className="p-6">Not found.</main>;
  function refresh() {
    setState("loading");
    setRevision((value) => value + 1);
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 bg-background p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Feedback inbox</h1>
        <Link to="/">Back to outline</Link>
      </header>
      <p className="text-sm text-muted-foreground">
        Private reports, newest first. Give member ideas extra weight, but
        prioritize security, data loss, and serious bugs on every plan.
      </p>
      <FieldGroup className="flex-row flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel htmlFor="inbox-status">Status</FieldLabel>
          <NativeSelect
            id="inbox-status"
            value={status}
            onChange={(event) => {
              setState("loading");
              setStatus(event.target.value);
              setNotice("");
            }}
          >
            <NativeSelectOption value="open">Open</NativeSelectOption>
            <NativeSelectOption value="complete">Complete</NativeSelectOption>
            <NativeSelectOption value="">All statuses</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="inbox-kind">Type</FieldLabel>
          <NativeSelect
            id="inbox-kind"
            value={kind}
            onChange={(event) => {
              setState("loading");
              setKind(event.target.value);
            }}
          >
            <NativeSelectOption value="">All feedback</NativeSelectOption>
            <NativeSelectOption value="bug">Bugs</NativeSelectOption>
            <NativeSelectOption value="idea">Ideas</NativeSelectOption>
            <NativeSelectOption value="question">Questions</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="inbox-plan">Plan at submission</FieldLabel>
          <NativeSelect
            id="inbox-plan"
            value={plan}
            onChange={(event) => {
              setState("loading");
              setPlan(event.target.value);
            }}
          >
            <NativeSelectOption value="">Every plan</NativeSelectOption>
            {Object.entries(PLAN_LABELS).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Button variant="outline" onClick={refresh}>
          Refresh
        </Button>
      </FieldGroup>
      <p role="status" className="text-sm text-muted-foreground">
        {notice}
      </p>
      {state === "loading" ? (
        <p role="status">Loading feedback…</p>
      ) : state === "error" ? (
        <p role="alert">Couldn't load feedback. Try Refresh.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Showing {result?.submissions.length ?? 0} most recent reports
            matching these filters (up to 100).
          </p>
          {result?.submissions.length === 0 && (
            <p>No reports match these filters.</p>
          )}
          {result?.submissions.map((entry) => (
            <FeedbackCard
              key={entry.id}
              entry={entry}
              mode={result.replyMode}
              onSaved={(updated, message) => {
                // Update just this report, preserving drafts on neighboring cards.
                setResult(
                  (current) =>
                    current && {
                      ...current,
                      submissions: current.submissions
                        .map((item) =>
                          item.id === updated.id
                            ? { ...item, ...updated }
                            : item,
                        )
                        .filter(
                          (item) =>
                            !status ||
                            (status === "open"
                              ? item.completedAt === null
                              : item.completedAt !== null),
                        ),
                    },
                );
                setNotice(message);
              }}
            />
          ))}
        </>
      )}
    </main>
  );
}
