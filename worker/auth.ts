/// <reference types="@cloudflare/workers-types" />

/**
 * Better Auth: the app's identity layer. Email + password self-serve signup,
 * sessions in D1. Better Auth's `user` table IS the global identity store and
 * `user.id` is the stable, permanent key the Worker routes each user's outline
 * Durable Object by (see resolveUserId in index.ts). See docs/adr/0011-the-auth-gate.md.
 *
 * Why a per-request factory and not a module singleton: the D1 binding only
 * exists inside `fetch(request, env)`, so auth MUST be constructed from `env`
 * per request. Identity lives in D1; the outline itself lives in the per-user
 * Durable Object.
 */

import { betterAuth } from 'better-auth'

/** The slice of the Worker env Better Auth needs. */
export interface AuthEnv {
  DB: D1Database
  /** Signing secret. Set in prod via `wrangler secret put BETTER_AUTH_SECRET`,
   *  locally via `.dev.vars`. Better Auth fails closed without it in prod. */
  BETTER_AUTH_SECRET?: string
  /** The deployment's public origin (e.g. https://dotflowy.example.com), used
   *  for cookie/redirect URLs and as a trusted origin. Unset in local dev. */
  BETTER_AUTH_URL?: string
}

export function createAuth(env: AuthEnv) {
  return betterAuth({
    // Better Auth accepts a D1 binding directly (kysely under the hood).
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
      // v1 has no transactional email wired, so signup can't gate on a
      // verification link yet. Tracked as a known gap (docs/adr/0011-the-auth-gate.md).
      requireEmailVerification: false,
    },
    // Dev serves the SPA from Vite (:3000) and proxies /api to the Worker, so
    // a sign-in request's Origin is the Vite origin, not the Worker's. Trust
    // the local dev origins explicitly; prod is covered by baseURL. e2e (:3210)
    // mocks /api/auth, so it never reaches this, but trusting it costs nothing.
    trustedOrigins: ['http://localhost:3000', 'http://localhost:3210'],
  })
}

export type Auth = ReturnType<typeof createAuth>
