import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client. Same-origin: baseURL defaults to the current
 * origin and the default basePath (/api/auth) matches the Worker's route. The
 * app is a pure SPA, so this is only ever used in the browser.
 */
const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;

/**
 * Sign out, then hard-navigate to "/". The data layer (nodesCollection, the kv
 * side-collections, tree store, undo history) is a set of module singletons and
 * the /api/sync WebSocket authenticates only at upgrade, so an SPA-internal auth
 * swap keeps the previous account's outline in memory and its socket open —
 * signing back in leaks that outline into the new account (cross-account
 * contamination). A full navigation is the only honest teardown: it destroys
 * every singleton and the socket. `replace` (not `assign`) keeps the dead auth
 * state out of history; "/" (not reload) drops the previous account's /$nodeId
 * URL. Better Auth's documented onSuccess pattern.
 */
export function signOutAndReload() {
  void signOut({
    fetchOptions: { onSuccess: () => window.location.replace("/") },
  });
}
