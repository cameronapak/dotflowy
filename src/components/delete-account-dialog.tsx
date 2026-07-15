import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { deleteUser, hardReset } from "../lib/auth-client";
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
 * "Delete account" confirmation (ticket #224 / docs/adr/0051), opened from the
 * header More menu. Deletion is PERMANENT and IMMEDIATE: it cancels any active
 * subscription, erases the outline (the per-user Durable Object), removes the
 * account, and signs out. We confirm by re-entering the password — the same
 * proof-of-ownership Better Auth's `deleteUser({ password })` requires (every
 * account has one; email+password is the only signup path, so this works even
 * for Google-linked accounts).
 *
 * On success we hard-navigate to "/" via `hardReset` — the auth-boundary
 * teardown rule (a full navigation destroys every data-layer singleton and the
 * sync socket, so nothing from the deleted account lingers), which also lands
 * on the signed-out screen.
 */
export function DeleteAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPassword("");
    setBusy(false);
    setError(null);
  }

  async function onConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    // try/catch, not just the {error} result: an unexpected rejection (network
    // throw, a client-plugin bug) would otherwise strand busy=true forever —
    // and both Cancel and onOpenChange gate on busy, so the dialog would be
    // permanently unclosable.
    try {
      const { error: err } = await deleteUser({ password });
      if (err) {
        // Wrong password, a fresh-session requirement, or a beforeDelete abort
        // (e.g. Stripe cancellation failed) all surface here — the account is
        // untouched, so let the user read why and retry.
        setError(
          err.message ?? "Couldn't delete your account. Please try again.",
        );
        setBusy(false);
        return;
      }
    } catch {
      setError("Couldn't delete your account. Please try again.");
      setBusy(false);
      return;
    }
    // Deleted. Tear everything down and land signed out.
    hardReset("/");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // don't let a mid-delete close strand the flow
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlertIcon className="size-5 text-destructive" />
            Delete your account
          </DialogTitle>
          <DialogDescription>
            This is permanent and immediate. It deletes your entire outline and
            your account, and cancels any active subscription. This can't be
            undone.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Want a copy first? Close this and use{" "}
          <span className="font-medium text-foreground">Export OPML</span> in
          the More menu to download your outline.
        </p>

        <form onSubmit={onConfirm} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Enter your password to confirm</span>
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || !password}
            >
              {busy && <Loader2Icon className="animate-spin" />}
              {busy ? "Deleting…" : "Delete account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
