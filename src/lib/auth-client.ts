import { stripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/react";
import { toast } from "sonner";

/**
 * Better Auth browser client. Same-origin: baseURL defaults to the current
 * origin and the default basePath (/api/auth) matches the Worker's route. The
 * app is a pure SPA, so this is only ever used in the browser.
 *
 * The bare `signOut` is deliberately NOT exported: a sign-out that skips the
 * hard navigation reintroduces the cross-account leak. Use signOutAndReload.
 *
 * The stripe plugin adds `subscription.*` — `.upgrade({ plan, annual })` for
 * hosted Checkout, `.list()` for the current plan, `.cancel()`/
 * `.billingPortal()` for self-serve — the surface #171's pricing UI consumes.
 */
const authClient = createAuthClient({
  plugins: [stripeClient({ subscription: true })],
});

export const {
  signIn,
  signUp,
  useSession,
  requestPasswordReset,
  resetPassword,
  subscription,
} = authClient;

/** The one fetch-failed message every auth surface shows, so a copy edit
 *  can't leave one screen reading differently from the rest. */
export const NETWORK_ERROR_MESSAGE =
  "Network error. Check your connection and try again.";

/**
 * Connect the signed-in account to a Google identity (explicit account
 * linking — the ONLY linking path while local emails are unverified; see
 * worker/auth.ts). Fully navigation-based: the client redirects to Google,
 * and Better Auth's callback redirects back to the current URL — success
 * lands silently, failure lands with ?error=… which
 * <OAuthCallbackErrorToast> surfaces. The round trip is a full page load,
 * so no singleton teardown concerns (same user, same data).
 */
export function connectGoogle() {
  void authClient.linkSocial({
    provider: "google",
    callbackURL: window.location.href,
    errorCallbackURL: window.location.href,
    fetchOptions: {
      onError: () => {
        toast.error("Couldn't start Google connect. Try again.");
      },
    },
  });
}

/**
 * Hard-navigate. The data layer (nodesCollection, the kv side-collections,
 * tree store, undo history) is a set of module singletons and the /api/sync
 * WebSocket authenticates only at upgrade, so an SPA-internal auth swap keeps
 * the previous account's outline in memory and its socket open — signing back
 * in leaks that outline into the new account (cross-account contamination). A
 * full navigation is the only honest teardown: it destroys every singleton and
 * the socket. `replace` (not `assign`) keeps the dead auth state out of
 * history. The default "/" target drops the previous account's /$nodeId URL —
 * right whenever the NEXT occupant is a different account (sign-out, the
 * account-switch guard in __root.tsx's AuthGate, sign-up); sign-in passes the
 * current URL instead so deep links and expiry re-auth keep their place. Every
 * auth boundary funnels through this.
 */
export function hardReset(target: string = "/") {
  window.location.replace(target);
}

/**
 * Start self-serve account deletion (ADR 0050). Email confirmation is
 * configured server-side, so this call only SENDS the confirmation email — it
 * does NOT delete anything. The actual teardown (cancel Stripe → wipe DO →
 * delete identity) runs when the user clicks the emailed link, whose
 * /delete-user/callback redirects to `callbackURL`: a full top-level navigation
 * that lands signed-out on the AuthScreen with ?account-deleted, which is the
 * hardReset singleton-teardown by construction (no client reload needed).
 * Returns Better Auth's `{ data, error }`.
 */
export function requestAccountDeletion() {
  return authClient.deleteUser({ callbackURL: "/?account-deleted=1" });
}

/**
 * Sign out, then hard-reset (Better Auth's documented onSuccess pattern). On
 * failure (offline, 5xx) the session cookie is still valid and no teardown ran,
 * so staying put is correct — but say so, or the user walks away from a shared
 * machine believing they signed out.
 */
export function signOutAndReload() {
  void authClient.signOut({
    fetchOptions: {
      onSuccess: () => hardReset(),
      onError: () => {
        toast.error("Sign out failed. Check your connection and try again.");
      },
    },
  });
}
