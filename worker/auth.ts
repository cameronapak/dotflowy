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

import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";

import { sendEmail } from "./email";

/** The slice of the Worker env Better Auth needs. */
export interface AuthEnv {
  DB: D1Database;
  /** The `send_email` binding (worker/email.ts). Optional: absent in plain
   *  local dev, where sends fall back to console logging. */
  EMAIL?: SendEmail;
  /** Signing secret. Set in prod via `wrangler secret put BETTER_AUTH_SECRET`,
   *  locally via `.dev.vars`. Better Auth fails closed without it in prod. */
  BETTER_AUTH_SECRET?: string;
  /** The deployment's public origin (e.g. https://dotflowy.example.com), used
   *  for cookie/redirect URLs and as a trusted origin. Unset in local dev. */
  BETTER_AUTH_URL?: string;
  /** Comma-separated invite codes gating signup (alpha is invite-only). Unset
   *  or empty = signup CLOSED — nobody can create an account. Rotate the
   *  secret to revoke every outstanding code at once. */
  INVITE_CODES?: string;
  /** Google OAuth client for "Sign in with Google". Both unset = the provider
   *  simply isn't registered (sign-in button errors with provider-not-found;
   *  local dev works fine without them). Set via `wrangler secret put`. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/** The password-reset email, as an HTML + plain-text pair (both always sent —
 *  spam score + client compatibility). Two templates is below the bar for a
 *  template system; inline strings are the system. */
function resetPasswordEmail(url: string) {
  return {
    subject: "Reset your Dotflowy password",
    text: `Reset your Dotflowy password:\n\n${url}\n\nThis link expires in 1 hour. If you didn't ask for a reset, you can ignore this email — your password is unchanged.`,
    html: `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; font-weight: 600;">Reset your Dotflowy password</h1>
  <p style="font-size: 14px; color: #444; line-height: 1.5;">Someone (hopefully you) asked to reset the password for this email address.</p>
  <p style="margin: 24px 0;"><a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; font-size: 14px; padding: 10px 16px; border-radius: 6px;">Choose a new password</a></p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">This link expires in 1 hour. If you didn't ask for a reset, ignore this email — your password is unchanged.</p>
</div>`,
  };
}

export function createAuth(
  env: AuthEnv,
  requestOrigin?: string,
  executionCtx?: ExecutionContext,
) {
  return betterAuth({
    // Better Auth accepts a D1 binding directly (kysely under the hood).
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    // Most of Better Auth infers the base URL from the request, but the mcp
    // plugin's OAuth discovery metadata REQUIRES an explicit one (it's the
    // OAuth `issuer`). Prod pins it via BETTER_AUTH_URL; otherwise fall back
    // to the calling request's origin (correct on any deployment + local dev).
    baseURL: env.BETTER_AUTH_URL ?? requestOrigin,
    emailAndPassword: {
      enabled: true,
      // Deliberately OFF for beta even though email is wired now: signup is
      // already invite-gated, so verification adds friction without closing a
      // real hole (a reset email always goes to the account's stored address,
      // so an unverified signup can't hijack anything). Revisit when signup
      // opens up (docs/adr/0011-the-auth-gate.md).
      requireEmailVerification: false,
      // The delivery function password reset was missing until #169. Better
      // Auth AWAITS this callback (no backgroundTasks handler configured), so
      // it must return fast and uniformly: the send rides ctx.waitUntil —
      // registered, not awaited — which (a) keeps the response time identical
      // whether or not the email exists (no enumeration side channel; the
      // endpoint already fakes the token work for unknown emails) and (b)
      // keeps the Workers isolate alive until the send finishes, which a bare
      // dangling promise would NOT survive. sendEmail itself never throws.
      sendResetPassword: async ({ user, url }) => {
        const send = sendEmail(env, {
          to: user.email,
          ...resetPasswordEmail(url),
        });
        if (executionCtx) executionCtx.waitUntil(send);
        else await send;
      },
      // A reset is the "my password leaked" move: kill every existing session
      // so a stolen one dies with the old password.
      revokeSessionsOnPasswordReset: true,
    },
    // "Sign in with Google" — sign-IN only. `disableSignUp: true` is the same
    // invite gate as the /sign-up/email hook, expressed for OAuth: a Google
    // callback with no matching account is rejected server-side instead of
    // creating a user, so the social path can't bypass INVITE_CODES. It must
    // be `disableSignUp` (hard), NOT `disableImplicitSignUp` — the latter is
    // waived by a client-supplied `requestSignUp: true`, which would reopen
    // the bypass. Registered only when both secrets exist so a bare local dev
    // env still constructs auth cleanly.
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              disableSignUp: true,
              prompt: "select_account",
            },
          }
        : undefined,
    // Account-linking policy (how an existing email+password user gets Google
    // on the same account — same `user.id`, hence the same outline DO):
    // EXPLICIT linking only, via `linkSocial` while signed in (the "Connect
    // Google" menu item). Implicit linking on a signed-out Google sign-in is
    // left at Better Auth's default, which refuses to link into a local
    // account whose email is unverified — ours all are (no verification
    // email yet) — because an attacker who pre-registered the victim's email
    // could otherwise capture the victim's Google identity. That refusal
    // surfaces as ?error=account_not_linked and the AuthScreen points at the
    // explicit path. (Don't "fix" it with `requireLocalEmailVerified: false`:
    // deprecated, and the gate becomes unconditional next minor.)
    account: {
      accountLinking: {
        // Google reports emailVerified, so this is belt-and-braces today; it
        // matters once local emails get verified (then implicit linking works).
        trustedProviders: ["google"],
        // Explicit link only: the live session already proves account
        // ownership, so the connected Google identity may use a different
        // address. Does NOT loosen the signed-out path (that lookup is
        // email-keyed, so a different-address Google sign-in just finds no
        // account and hits disableSignUp).
        allowDifferentEmails: true,
      },
    },
    // Dev serves the SPA from Vite (:3000) and proxies /api to the Worker, so
    // a sign-in request's Origin is the Vite origin, not the Worker's. Trust
    // the local dev origins explicitly; prod is covered by baseURL. e2e (:3210)
    // mocks /api/auth, so it never reaches this, but trusting it costs nothing.
    trustedOrigins: ["http://localhost:3000", "http://localhost:3210"],
    // Invite-only alpha: /sign-up/email is the ONLY account-creation path (the
    // mcp plugin's dynamic registration creates OAuth clients, not users), so
    // gating it here closes signup entirely. Server-side on purpose — hiding
    // the signup UI wouldn't stop a direct POST to the endpoint. An unset
    // INVITE_CODES fails CLOSED: no codes, no signups; sign-in is untouched.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const codes = (env.INVITE_CODES ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const supplied =
          typeof ctx.body?.inviteCode === "string"
            ? ctx.body.inviteCode.trim()
            : "";
        if (!supplied || !codes.includes(supplied)) {
          throw new APIError("FORBIDDEN", {
            message:
              "Dotflowy is invite-only during alpha. Ask for an invite code, or join the waitlist.",
          });
        }
      }),
    },
    // OAuth 2.1 authorization server for the MCP endpoint (/mcp): PKCE
    // authorization-code flow with dynamic client registration, tokens in D1
    // (migration 0004). The SPA's AuthScreen doubles as the login page — the
    // authorize endpoint stashes the OAuth query in a signed cookie, sends the
    // signed-out user to `/`, and resumes the flow after sign-in (the plugin's
    // after-hook plus AuthScreen's explicit authorize-redirect fallback).
    // See docs/adr/0026-agent-native-mcp-server.md.
    plugins: [mcp({ loginPage: "/" })],
  });
}

export type Auth = ReturnType<typeof createAuth>;
