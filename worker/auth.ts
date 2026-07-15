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

import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";
import Stripe from "stripe";

import type { UserOutlineDO } from "./outline-do";

import {
  cancelActiveSubscriptions,
  deleteResidualUserRows,
  isOwnerAccount,
} from "./account-deletion";
import { sendEmail } from "./email";
import { FOUNDING_SEAT_LIMIT, countFoundingSeats } from "./plan";

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
  /** Stripe API key (`sk_test_…` locally, `sk_live_…` in prod via
   *  `wrangler secret put STRIPE_SECRET_KEY`). Unset = billing endpoints exist
   *  but every Stripe call fails; sign-in/sync/MCP are untouched. */
  STRIPE_SECRET_KEY?: string;
  /** Webhook signing secret for /api/auth/stripe/webhook (`whsec_…`). From the
   *  dashboard endpoint in prod, `stripe listen` locally. Unset = webhook
   *  signature verification fails closed. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** The per-user outline Durable Object namespace. Self-serve account deletion
   *  (ticket #224) reaches the caller's DO through this to wipe their outline as
   *  part of the delete lifecycle — the same binding worker/index.ts routes
   *  /api/nodes through, resolved here from the authenticated session's user.id
   *  (never a client-supplied id; the DO trust boundary, ADR 0014). */
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>;
  /** The owner's Better Auth `user.id`. When set, that one account routes to the
   *  constant 'default' DO (worker/index.ts resolveUserId); self-serve deletion
   *  refuses it (docs/adr/0051). */
  OWNER_USER_ID?: string;
}

/**
 * Stripe Price lookup keys — the stable, environment-independent handle the
 * plugin resolves to a live price id at checkout time. The Prices created in
 * the Stripe dashboard (test AND live mode) MUST carry these lookup keys;
 * that's the whole coupling, no price-id env vars. Pricing per #152:
 * unlimited $5/mo · $48/yr; founding $99 · 3-year interval (Stripe's max —
 * the price itself is `recurring: { interval: 'year', interval_count: 3 }`).
 */
export const STRIPE_LOOKUP_KEYS = {
  unlimitedMonthly: "dotflowy_unlimited_monthly",
  unlimitedAnnual: "dotflowy_unlimited_annual",
  founding: "dotflowy_founding",
} as const;

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
    // Self-serve account deletion (ticket #224 / docs/adr/0051). Confirmed
    // client-side by re-entering the password (`authClient.deleteUser({password})`)
    // — every account has one (email+password is the only signup path), so the
    // password path always works even for Google-linked accounts. Email
    // verification is deliberately NOT wired (`sendDeleteAccountVerification`
    // absent): verification is off for beta (ADR 0011), and the fresh-password
    // check already proves it's the account owner at the keyboard.
    user: {
      deleteUser: {
        enabled: true,
        // beforeDelete runs while the account still exists, so it's the only
        // safe place to (1) refuse the un-deletable owner account, (2) cancel
        // Stripe BEFORE the rows it references vanish, and (3) wipe the outline
        // DO. A throw here ABORTS the deletion with nothing destroyed — which is
        // exactly what we want if Stripe cancellation fails (a paying
        // subscription must never outlive its account). Order matters: guard →
        // Stripe (external, must succeed) → DO wipe (irreversible, last).
        beforeDelete: async (user) => {
          if (isOwnerAccount(user.id, env.OWNER_USER_ID)) {
            throw new APIError("FORBIDDEN", {
              message:
                "This account can't be deleted from the app. Contact support.",
            });
          }
          // Throws on a real Stripe failure → deletion aborts, DO untouched.
          await cancelActiveSubscriptions(env, user.id);
          // Non-owner, so resolveUserId(user.id) === user.id: the caller's own
          // DO, resolved from the authenticated user.id (never client input).
          const stub = env.USER_OUTLINE.get(
            env.USER_OUTLINE.idFromName(user.id),
          );
          await stub.wipe();
        },
        // afterDelete runs once the identity rows are gone. Better Auth's core
        // deletes user/session/account; the subscription row (no FK) and the
        // mcp OAuth rows are cleaned here. Best-effort: any leftover is
        // unreachable (nothing routes to a deleted user.id), so a failure here
        // never un-does an already-completed deletion.
        afterDelete: async (user) => {
          await deleteResidualUserRows(env.DB, user.id);
        },
      },
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
    // Billing (issue #162): the @better-auth/stripe plugin owns the whole
    // Stripe surface — checkout via `subscription.upgrade()`, the webhook at
    // /api/auth/stripe/webhook (inside the /api/auth/* prefix index.ts already
    // routes BEFORE the session gate — zero new routing), and the D1
    // `subscription` table (migration 0006) that worker/plan.ts reads for
    // entitlements. Nothing calls Stripe on the request path.
    //
    // The plugin is unconditional so `Auth`'s inferred type (and the D1
    // schema) never depends on which secrets are set; a missing key only
    // breaks the billing endpoints themselves (stripe-node throws at call
    // time, not construction — the placeholder key is never sent anywhere
    // except a failing Stripe call on a box without .dev.vars keys).
    //
    // stripe-node v22 ships workerd export conditions, so `new Stripe(key)`
    // auto-selects the fetch HTTP client + SubtleCrypto webhook verification.
    //
    // OAuth 2.1 authorization server for the MCP endpoint (/mcp): PKCE
    // authorization-code flow with dynamic client registration, tokens in D1
    // (migration 0004). The SPA's AuthScreen doubles as the login page — the
    // authorize endpoint stashes the OAuth query in a signed cookie, sends the
    // signed-out user to `/`, and resumes the flow after sign-in (the plugin's
    // after-hook plus AuthScreen's explicit authorize-redirect fallback).
    // See docs/adr/0026-agent-native-mcp-server.md.
    plugins: [
      mcp({ loginPage: "/" }),
      stripe({
        stripeClient: new Stripe(
          env.STRIPE_SECRET_KEY ?? "sk_test_placeholder",
        ),
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
        // No Stripe customer until first checkout: alpha users need no
        // backfill, and the free tier is the absence of a subscription row.
        // The plugin creates the customer lazily at first `upgrade()`.
        createCustomerOnSignUp: false,
        subscription: {
          enabled: true,
          // Both plans are ALWAYS listed. Don't gate the founding cap by
          // withholding it from an async `plans` fn: webhooks and
          // `subscription.list()` resolve a subscription's plan from this
          // same list, so a withheld plan would break state updates for the
          // 50 people who already bought it. The cap gates checkout below.
          plans: [
            {
              name: "unlimited",
              lookupKey: STRIPE_LOOKUP_KEYS.unlimitedMonthly,
              annualDiscountLookupKey: STRIPE_LOOKUP_KEYS.unlimitedAnnual,
            },
            {
              name: "founding",
              lookupKey: STRIPE_LOOKUP_KEYS.founding,
            },
          ],
          // The founding 50-seat cap, enforced server-side at the moment a
          // checkout session would be created (hiding the pricing card is
          // #171's UX; this is the wall a direct POST hits). Runs only on
          // /subscription/upgrade, never on the request path. At the boundary
          // a race can oversell by a seat — that's a refund-one-customer
          // problem, per #162.
          getCheckoutSessionParams: async ({ plan }) => {
            if (
              plan.name === "founding" &&
              (await countFoundingSeats(env.DB)) >= FOUNDING_SEAT_LIMIT
            ) {
              throw new APIError("FORBIDDEN", {
                message:
                  "All founding seats are taken. The unlimited plan is available.",
              });
            }
            return {};
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
