import { Loader2Icon, MailCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  NETWORK_ERROR_MESSAGE,
  requestAccountDeletion,
} from "../lib/auth-client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

/**
 * Self-serve account deletion dialog (ADR 0050, ticket #224), opened from the
 * header More menu. Two stages:
 *
 *  1. "form" — the type-to-confirm intent gate ("DELETE") plus the three
 *     surprises stated plainly (permanent, cancels the subscription with no
 *     automatic refund, backups purge in 30 days). Submitting does NOT delete
 *     anything: it calls requestAccountDeletion, which SENDS a confirmation
 *     email (identity proof — uniform across password + Google-only accounts).
 *  2. "sent" — "check your email"; the emailed link is what actually deletes
 *     (its callback redirects here signed-out, a full-navigation teardown).
 *
 * The word to type is "DELETE" (case-insensitive, trimmed) — an intent gate,
 * not identity proof; the email link is the identity proof.
 */

const CONFIRM_WORD = "DELETE";

type Stage = "form" | "sent";

export function DeleteAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage>("form");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to a clean form whenever the dialog closes, so reopening never shows
  // a stale "sent" screen or a half-typed confirmation.
  useEffect(() => {
    if (!open) {
      setStage("form");
      setConfirmText("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const confirmed = confirmText.trim().toUpperCase() === CONFIRM_WORD;

  async function onSubmit() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestAccountDeletion();
      if (res.error) {
        setError(res.error.message ?? "Couldn't start deletion. Try again.");
        setBusy(false);
        return;
      }
      setStage("sent");
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {stage === "form" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TriangleAlertIcon className="size-5 text-destructive" />
                Delete your account
              </DialogTitle>
              <DialogDescription>
                This permanently deletes your account and your entire outline.
                It cannot be undone.
              </DialogDescription>
            </DialogHeader>

            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Your outline and all your data are permanently erased.</li>
              <li>
                Any active subscription is cancelled immediately, with no
                automatic refund. Contact support within 14 days if you're
                eligible.
              </li>
              <li>Backups are purged within 30 days.</li>
              <li>
                We'll email you a confirmation link — deletion only happens once
                you click it.
              </li>
            </ul>

            <div className="space-y-1.5">
              <label htmlFor="delete-confirm" className="text-sm font-medium">
                Type <span className="font-semibold">{CONFIRM_WORD}</span> to
                confirm
              </label>
              <Input
                id="delete-confirm"
                autoComplete="off"
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmit();
                }}
                placeholder={CONFIRM_WORD}
                aria-invalid={error ? true : undefined}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={onSubmit}
                disabled={!confirmed || busy}
              >
                {busy && <Loader2Icon className="animate-spin" />}
                Email me the deletion link
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <MailCheckIcon className="size-5" />
                Check your email
              </DialogTitle>
              <DialogDescription>
                We sent a confirmation link to your email address. Click it to
                permanently delete your account. The link expires in 24 hours;
                until you click it, nothing is deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
