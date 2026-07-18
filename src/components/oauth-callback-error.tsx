import { useEffect } from "react";
import { toast } from "sonner";

/**
 * OAuth callback failures arrive as a top-level redirect back to the app with
 * `?error=<code>` (Better Auth's redirectOnError; we pass the current URL as
 * `errorCallbackURL`). Two surfaces read it, one per auth state: the signed-out
 * AuthScreen shows it inline (a failed "Continue with Google"), and the
 * signed-in <OAuthCallbackErrorToast> toasts it (a failed "Connect Google"
 * link). Both funnel through consumeOAuthCallbackError, which also strips the
 * error params from the URL so a reload — or the AuthScreen's keep-current-URL
 * sign-in — doesn't resurface a stale error.
 */

const MESSAGES: Record<string, string> = {
  // A Google identity with no Dotflowy account hit the server-side signup
  // gate (worker/auth.ts `disableSignUp` — the OAuth face of the invite gate).
  signup_disabled:
    "That Google account isn't connected to a Dotflowy account yet. Sign up with your email first, then connect Google from the More menu.",
  // An email+password account exists at this address but isn't linked, and
  // implicit linking refused (unverified local email). The fix is the
  // explicit, authenticated path.
  account_not_linked:
    "That email already has a Dotflowy password account. Sign in with your password, then connect Google from the More menu.",
  account_already_linked_to_different_user:
    "That Google account is already connected to a different Dotflowy account.",
  // The user backed out at Google's consent screen.
  access_denied: "Google sign-in was cancelled.",
};

/** Read a pending OAuth callback error, strip it from the URL, and return the
 *  human message (null when the page load carries no error). */
export function consumeOAuthCallbackError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("error");
  if (!code) return null;
  params.delete("error");
  params.delete("error_description");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    window.location.pathname +
      (query ? `?${query}` : "") +
      window.location.hash,
  );
  return (
    MESSAGES[code] ?? `Google sign-in didn't complete (${code}). Try again.`
  );
}

/** Signed-in surface: toasts a link-Google failure once on mount. */
export function OAuthCallbackErrorToast() {
  // Guarded so Strict Mode's double effect can't clear the message: only the
  // first call sees the param (consume strips it) and only truthy toasts.
  useEffect(() => {
    const message = consumeOAuthCallbackError();
    if (message) toast.error(message, { duration: 10_000 });
  }, []);
  return null;
}
