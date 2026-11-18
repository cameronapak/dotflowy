import { createFileRoute } from "@tanstack/react-router";
import { Effect, Fiber, Schema } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import { AdminNav } from "../components/admin-nav";
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
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { ProCodes, type ProCodeAction } from "../data/pro-reward";
import { saveReward } from "../data/pro-reward-api";

export const Route = createFileRoute("/admin/pro-codes")({
  component: ProCodeAdmin,
});

class CodeHistoryError extends Schema.TaggedError<CodeHistoryError>()(
  "CodeHistoryError",
  {},
) {}

const loadCodes = Effect.fn("loadCodes")(function* (before: string | null) {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  );
  const response = yield* Effect.tryPromise((signal) =>
    fetch(
      `/api/admin/pro-codes${before ? `?before=${encodeURIComponent(before)}` : ""}`,
      { signal: AbortSignal.any([signal, controller.signal]) },
    ),
  );
  if (!response.ok) return yield* Effect.fail(new CodeHistoryError({}));
  const data: unknown = yield* Effect.tryPromise(() => response.json());
  return yield* Schema.decodeUnknownEffect(ProCodes)(data);
}, Effect.scoped);

function ProCodeAdmin() {
  const [history, setHistory] = useState<typeof ProCodes.Type | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [reason, setReason] = useState("");
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    id: string;
    action: "replace" | "revoke";
  } | null>(null);
  const saving = useRef(false);
  const attempt = useRef<{ id: string; reason: string } | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const refresh = useCallback((cursor: string | null = null) => {
    setLoading(true);
    setLoadError("");
    setBefore(cursor);
    setRevision((v) => v + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const fiber = Effect.runFork(
      loadCodes(before).pipe(
        Effect.match({
          onSuccess: (data) => {
            if (active) setHistory(data);
          },
          onFailure: () => {
            if (active)
              setLoadError("Couldn't load code history. Try Refresh.");
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (active) setLoading(false);
          }),
        ),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [before, revision]);
  useEffect(() => {
    const focus = () => refresh(before);
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [before, refresh]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function save(action: ProCodeAction) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setSecret("");
    Effect.runFork(
      saveReward("/api/admin/pro-codes", action).pipe(
        Effect.match({
          onSuccess: (result) => {
            if (action.action === "create") {
              attempt.current = null;
              setReason("");
            }
            setSecret(result.code ?? "");
            setNotice(
              result.code
                ? "Code ready. Copy it now and send it privately."
                : action.action === "create"
                  ? "This code was created earlier. Find it in history and replace it if you need a new copy."
                  : action.action === "revoke"
                    ? "Code revoked. It can no longer be redeemed."
                    : (result.reward?.message ?? "Code updated."),
            );
            setConfirm(null);
            refresh();
          },
          onFailure: (error) => setError(error.message),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            saving.current = false;
            setBusy(false);
          }),
        ),
      ),
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 bg-background p-6">
      <AdminNav />
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Pro codes</h1>
        <p className="text-sm text-muted-foreground">
          Give someone 30 extra days of Pro. No recipient or in-app report
          required.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle id="generate-code-title">Generate a 30-day code</CardTitle>
          <CardDescription>
            Single-use, claimable for 90 days. The first verified account to
            redeem it claims it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action="/api/admin/pro-codes"
            method="post"
            aria-labelledby="generate-code-title"
            onSubmit={(e) => {
              e.preventDefault();
              const text = reason.trim();
              if (!text) {
                setNotice("");
                setError("Add a reason for this code.");
                return;
              }
              if (attempt.current?.reason !== text)
                attempt.current = { id: crypto.randomUUID(), reason: text };
              void save({ action: "create", ...attempt.current });
            }}
          >
            <FieldGroup>
              <Field
                data-disabled={busy}
                data-invalid={!!error && !reason.trim()}
              >
                <FieldLabel htmlFor="code-reason">
                  Reason / internal comment (required)
                </FieldLabel>
                <Textarea
                  id="code-reason"
                  name="reason"
                  required
                  maxLength={1000}
                  value={reason}
                  disabled={busy}
                  aria-invalid={!!error && !reason.trim()}
                  aria-describedby="code-reason-help"
                  placeholder="Fixed keyboard bug, GitHub issue #123"
                  onChange={(e) => {
                    setReason(e.target.value);
                    setError("");
                  }}
                />
                <FieldDescription id="code-reason-help">
                  Only admins see this note. Include a GitHub issue reference or
                  why you're saying thank you.
                </FieldDescription>
              </Field>
              <Button type="submit" className="self-start" disabled={busy}>
                {busy ? "Saving…" : "Generate 30-day code"}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {secret && (
        <Field>
          <FieldLabel htmlFor="generated-pro-code">Generated code</FieldLabel>
          <Input
            id="generated-pro-code"
            name="generated-code"
            readOnly
            value={secret}
            onFocus={(e) => e.target.select()}
            aria-describedby="generated-pro-code-help"
          />
          <FieldDescription id="generated-pro-code-help">
            Shown only now. Anyone with this code can claim it first. Send it
            privately with the link {window.location.origin}/redeem. The code
            stays separate from the link. No email was sent.
          </FieldDescription>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => {
              Effect.runFork(
                Effect.tryPromise(() =>
                  navigator.clipboard.writeText(
                    `Thank you for helping make Dotflowy better. Here's 30 days of Pro.\n\nRedeem: ${window.location.origin}/redeem\nCode: ${secret}`,
                  ),
                ).pipe(
                  Effect.match({
                    onSuccess: () => setNotice("Link and code copied."),
                    onFailure: () =>
                      setNotice("Select the code field and copy it manually."),
                  }),
                ),
              );
            }}
          >
            Copy link and code
          </Button>
        </Field>
      )}
      <section
        className="flex flex-col gap-4"
        aria-labelledby="code-history-title"
        aria-busy={loading}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="code-history-title" className="text-base font-medium">
            Code history
          </h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || loading}
            onClick={() => refresh(before)}
          >
            Refresh
          </Button>
        </div>
        {loadError && (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        )}
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading code history…
          </p>
        )}
        {!loading && !loadError && history?.codes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No codes yet. Generate one above when you want to thank someone.
          </p>
        )}
        {history?.codes.map((code) => (
          <Card key={code.id} data-testid="pro-code">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <span>{code.label}</span>
                <Badge
                  variant={code.status === "unused" ? "outline" : "secondary"}
                >
                  {code.status === "used" && code.state !== "applied"
                    ? "Claimed"
                    : `${code.status.charAt(0).toUpperCase()}${code.status.slice(1)}`}
                </Badge>
              </CardTitle>
              <CardDescription>
                Created{" "}
                <time dateTime={new Date(code.createdAt).toISOString()}>
                  {new Date(code.createdAt).toLocaleString()}
                </time>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="break-words whitespace-pre-wrap">{code.reason}</p>
              <p className="text-sm text-muted-foreground">
                {code.claimedAt ? (
                  <>
                    Redeemed {new Date(code.claimedAt).toLocaleString()} by{" "}
                    <span className="break-all">
                      {code.redeemedBy ?? "deleted account"}
                    </span>
                    .
                  </>
                ) : (
                  <>Claim by {new Date(code.claimBy).toLocaleString()}.</>
                )}
              </p>
              {code.status === "used" && (
                <p className="text-sm">
                  {code.message}
                  {code.endsAt && code.state === "applied"
                    ? ` Reward ends ${new Date(code.endsAt).toLocaleString()}.`
                    : ""}
                </p>
              )}
              {confirm?.id === code.id ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    {confirm.action === "replace"
                      ? "Replace this code? The old code stops working and the new one can be claimed for 90 days."
                      : "Revoke this code? It will no longer work."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void save(confirm)}
                    >
                      {confirm.action === "replace"
                        ? "Confirm replacement"
                        : "Confirm revocation"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirm(null)}
                    >
                      Back
                    </Button>
                  </div>
                </div>
              ) : code.status === "unused" || code.status === "expired" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({ id: code.id, action: "replace" })
                    }
                  >
                    Replace code
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({ id: code.id, action: "revoke" })
                    }
                  >
                    Revoke code
                  </Button>
                </div>
              ) : code.status === "used" &&
                ["pending", "review", "scheduled"].includes(code.state) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={busy}
                  onClick={() => void save({ action: "retry", id: code.id })}
                >
                  Check or retry same reward
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ))}
        <div className="flex flex-wrap gap-2">
          {before && (
            <Button
              type="button"
              variant="outline"
              disabled={loading || busy}
              onClick={() => refresh()}
            >
              Newest codes
            </Button>
          )}
          {history?.next && (
            <Button
              type="button"
              variant="outline"
              disabled={loading || busy}
              onClick={() => refresh(history.next)}
            >
              Older codes
            </Button>
          )}
        </div>
      </section>
    </main>
  );
}
