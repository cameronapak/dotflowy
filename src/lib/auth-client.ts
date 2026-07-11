import { createAuthClient } from "better-auth/react";
import { toast } from "sonner";

/**
 * Better Auth browser client. Same-origin: baseURL defaults to the current
 * origin and the default basePath (/api/auth) matches the Worker's route. The
 * app is a pure SPA, so this is only ever used in the browser.
 *
 * The bare `signOut` is deliberately NOT exported: a sign-out that skips the
 * hard navigation reintroduces the cross-account leak. Use signOutAndReload.
 */
const authClient = createAuthClient();

export const { signIn, signUp, useSession } = authClient;

/**
 * Hard-navigate to "/". The data layer (nodesCollection, the kv
 * side-collections, tree store, undo history) is a set of module singletons and
 * the /api/sync WebSocket authenticates only at upgrade, so an SPA-internal auth
 * swap keeps the previous account's outline in memory and its socket open —
 * signing back in leaks that outline into the new account (cross-account
 * contamination). A full navigation is the only honest teardown: it destroys
 * every singleton and the socket. `replace` (not `assign`) keeps the dead auth
 * state out of history; "/" (not reload) drops the previous account's /$nodeId
 * URL. Every auth boundary (sign-out here, sign-in/sign-up in auth-screen.tsx,
 * the account-switch guard in __root.tsx's AuthGate) funnels through this.
 */
export function hardResetToRoot() {
  window.location.replace("/");
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
      onSuccess: hardResetToRoot,
      onError: () => {
        toast.error("Sign out failed. Check your connection and try again.");
      },
    },
  });
}
