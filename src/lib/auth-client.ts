import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";

/**
 * Better Auth browser client. Same-origin: baseURL defaults to the current
 * origin and the default basePath (/api/auth) matches the Worker's route. The
 * app is a pure SPA, so this is only ever used in the browser.
 *
 * `apiKeyClient` powers personal access tokens for headless `POST /api/quick-add`
 * (issue #96). Keys never unlock the rest of the session-gated API.
 */
const authClient = createAuthClient({
  plugins: [apiKeyClient()],
});

export const { signIn, signUp, signOut, useSession, apiKey } = authClient;
