import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { buttonVariants } from "../components/ui/button-variants";
import { Input } from "../components/ui/input";

/**
 * Admin-only "restore one user" view (ticket #220). Like /admin/waitlist, the
 * REAL gate is server-side: POST /api/admin/restore requires a session whose
 * email is on the Worker's ADMIN_EMAILS allowlist and 404s otherwise — this page
 * is just a thin renderer over that endpoint, so a non-admin who guesses the URL
 * and submits sees the same "Not found." a bad route would give. Deliberately
 * unlinked from the app chrome, no dialog framework. The heavy lifting (the DO's
 * 30-day Point-in-Time Recovery) is the endpoint's; see
 * docs/runbooks/restore-user-pitr.md for the curl equivalent and the undo flow.
 */

interface RestoreResult {
  previousBookmark: string;
  targetBookmark: string;
}

export const Route = createFileRoute("/admin/restore")({
  component: AdminRestore,
});

/** A datetime-local value ("2026-07-17T12:00") -> epoch ms, or null if empty. */
function localDateTimeToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function AdminRestore() {
  const [identifier, setIdentifier] = useState("");
  const [when, setWhen] = useState("");
  const [bookmark, setBookmark] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A 404 (non-admin, or missing route) flips the whole page to "Not found.",
  // exactly like the waitlist page — the admin surface must not advertise itself.
  const [denied, setDenied] = useState(false);

  const trimmedId = identifier.trim();
  const trimmedBookmark = bookmark.trim();
  const hasWhen = when.trim().length > 0;
  const hasBookmark = trimmedBookmark.length > 0;
  // Need an identifier and at least one restore point. A bookmark (the undo
  // path) wins over the time — `runRestore` sends only the bookmark when both are
  // set, never both — so don't gate on their being mutually exclusive here (that
  // plus the disabled time field would strand an operator who filled both).
  const canReview = trimmedId.length > 0 && (hasBookmark || hasWhen);

  async function runRestore() {
    setSubmitting(true);
    setError(null);
    // Send email or user id by shape ("@" => email); the endpoint keys the DO on
    // the resolved user id either way. Bookmark (undo) takes precedence over time.
    const body: Record<string, unknown> = trimmedId.includes("@")
      ? { email: trimmedId }
      : { userId: trimmedId };
    if (hasBookmark) body.bookmark = trimmedBookmark;
    else body.at = localDateTimeToMs(when);

    try {
      const res = await fetch("/api/admin/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 404) {
        setDenied(true);
        return;
      }
      const data = (await res.json()) as RestoreResult | { error?: string };
      if (!res.ok) {
        setError(("error" in data && data.error) || "Restore failed.");
        return;
      }
      setResult(data as RestoreResult);
      setConfirming(false);
    } catch {
      setError("Restore failed — could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  if (denied) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">Not found.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-2xl bg-background p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Restore a user</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Roll one user&rsquo;s outline back within the last 30 days. Isolated
            to that user; other outlines are untouched.
          </p>
        </div>
        <Link
          to="/"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Back to outline
        </Link>
      </div>

      {result ? (
        <RestoreDone result={result} onReset={() => setResult(null)} />
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">User email or id</span>
            <Input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="user@example.com or usr_abc123"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Restore to (your local time)
            </span>
            <Input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              disabled={hasBookmark}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              …or a raw bookmark (the undo path)
            </span>
            <Input
              value={bookmark}
              onChange={(e) => setBookmark(e.target.value)}
              placeholder="paste the previousBookmark from an earlier restore"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              A prior restore returns a <code>previousBookmark</code>; paste it
              here to reverse it. A bookmark overrides the time above.
            </span>
          </label>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          {confirming ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">
                This rolls back {trimmedId || "this user"}&rsquo;s entire
                outline
                {hasBookmark
                  ? " to the pasted bookmark"
                  : ` to ${when.replace("T", " ")}`}
                . Everything they&rsquo;ve changed since is discarded.
                You&rsquo;ll get a bookmark to undo it, but confirm you mean it.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={submitting}
                  onClick={runRestore}
                >
                  {submitting ? "Restoring…" : "Confirm restore"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={submitting}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                variant="destructive"
                disabled={!canReview}
                onClick={() => {
                  setError(null);
                  setConfirming(true);
                }}
              >
                Review restore…
              </Button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function RestoreDone({
  result,
  onReset,
}: {
  result: RestoreResult;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">Restore armed.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The user&rsquo;s outline is rolling back now; open tabs reconnect to
          the restored state within a second or two. Save the{" "}
          <strong>previous bookmark</strong> below — pasting it into the
          bookmark field undoes this restore.
        </p>
      </div>

      <BookmarkField
        label="Previous bookmark (undo this restore)"
        value={result.previousBookmark}
      />
      <BookmarkField
        label="Target bookmark (what you restored to)"
        value={result.targetBookmark}
      />

      <div>
        <Button variant="outline" size="sm" onClick={onReset}>
          Restore another point
        </Button>
      </div>
    </div>
  );
}

function BookmarkField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          {value}
        </code>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
