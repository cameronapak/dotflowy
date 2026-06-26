import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client. Same-origin: baseURL defaults to the current
 * origin and the default basePath (/api/auth) matches the Worker's route. The
 * app is a pure SPA, so this is only ever used in the browser.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
