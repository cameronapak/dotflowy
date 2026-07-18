import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  hardReset,
  NETWORK_ERROR_MESSAGE,
  resetPassword,
} from "../lib/auth-client";

/**
 * The password-reset landing page. The emailed link points at Better Auth's
 * /api/auth/reset-password/:token endpoint, which validates the token and
 * redirects here with ?token=… (or ?error=INVALID_TOKEN when it's expired or
 * already used). This page is PUBLIC by construction — the visitor has no
 * session, that's the whole point — so __root.tsx renders it OUTSIDE the
 * AuthGate (and outside the editor chrome, whose dialogs assume a session).
 *
 * On success the user is NOT signed in (revokeSessionsOnPasswordReset also
 * killed every existing session), so we hard-navigate to the sign-in screen.
 */

interface ResetSearch {
  token?: string;
  error?: string;
}

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetSearch => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const { token, error: linkError } = Route.useSearch();
  const [password, setPassword] = useState("");
  // A confirmation field so a mistyped new password can't lock the user out.
  const [confirmPassword, setConfirmPassword] = useState("");
  // Gate the mismatch message: shown after the field is blurred or on submit,
  // not on the first keystroke.
  const [confirmTouched, setConfirmTouched] = useState(false);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const invalidLink = !token || Boolean(linkError);
  // Only compare once both fields have content.
  const passwordsMismatch =
    password.length > 0 &&
    confirmPassword.length > 0 &&
    password !== confirmPassword;
  const showConfirmError = confirmTouched && passwordsMismatch;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    // Block a mismatched confirmation before hitting the network; the
    // field-level message explains, so this just surfaces it and moves focus.
    if (password !== confirmPassword) {
      setConfirmTouched(true);
      confirmRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await resetPassword({ newPassword: password, token });
      if (res.error) {
        setError(
          res.error.message ??
            "Couldn't reset the password. The link may have expired — request a new one.",
        );
      } else {
        setDone(true);
      }
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    }
    setBusy(false);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">Dotflowy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a new password
          </p>
        </div>

        {done || invalidLink ? (
          // One terminal card, two scripts. Both exits hard-navigate to "/":
          // after a SUCCESSFUL reset every session is revoked, so "/" is the
          // sign-in screen; on a dead link a still-signed-in visitor lands in
          // their outline instead — hence the neutral button label.
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              {done
                ? "Password updated. Sign in with your new password."
                : "This reset link is invalid or has expired. Request a new one from the sign-in screen."}
            </p>
            <Button className="w-full" onClick={() => hardReset("/")}>
              {done ? "Go to sign in" : "Back to Dotflowy"}
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              type="password"
              placeholder="New password"
              autoComplete="new-password"
              required
              minLength={8}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input
              ref={confirmRef}
              type="password"
              placeholder="Confirm new password"
              autoComplete="new-password"
              required
              minLength={8}
              aria-invalid={showConfirmError || undefined}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onBlur={() => setConfirmTouched(true)}
            />
            {showConfirmError && (
              <p className="text-sm text-destructive">Passwords don't match.</p>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "…" : "Set new password"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
