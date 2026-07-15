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

import { deleteAccountData, scrubUserPii } from "./delete-account";
import { sendEmail } from "./email";
import { isRedeemableInvite, normalizeEmail, redeemInvite } from "./invites";
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
  /** The per-user outline Durable Object namespace — the account-deletion
   *  teardown wipes the deleted user's DO through it (ADR 0050). */
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>;
  /** The owner's Better Auth `user.id` (owner-continuity bridge, index.ts). The
   *  delete teardown reads it so it wipes the SAME DO the request router uses. */
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

/** The account-deletion confirmation email (ADR 0050). Deletion is gated on
 *  clicking this link — the uniform, strongest proof of intent + identity for
 *  an irreversible action, and it works identically for password and
 *  Google-only accounts. The copy is explicit about the three things that
 *  surprise people: it's immediate + permanent, it cancels the subscription
 *  with no automatic refund, and backups purge within 30 days (ADR 0050 / the
 *  privacy page, #226). */
function deleteAccountEmail(url: string) {
  return {
    subject: "Confirm your Dotflowy account deletion",
    text: `Confirm you want to permanently delete your Dotflowy account:\n\n${url}\n\nThis permanently deletes your outline and account — it cannot be undone. Any active subscription is cancelled immediately with no automatic refund (contact support within 14 days if you're eligible). Backups are purged within 30 days.\n\nThis link expires in 24 hours. If you didn't ask to delete your account, ignore this email — nothing will happen.`,
    html: `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; font-weight: 600;">Confirm account deletion</h1>
  <p style="font-size: 14px; color: #444; line-height: 1.5;">Click below to <strong>permanently delete</strong> your Dotflowy account and outline. This cannot be undone.</p>
  <p style="margin: 24px 0;"><a href="${url}" style="display: inline-block; background: #b91c1c; color: #fff; text-decoration: none; font-size: 14px; padding: 10px 16px; border-radius: 6px;">Delete my account</a></p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">Any active subscription is cancelled immediately with no automatic refund (contact support within 14 days if you're eligible). Backups are purged within 30 days. This link expires in 24 hours.</p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">If you didn't ask to delete your account, ignore this email — nothing will happen.</p>
</div>`,
  };
}

export function createAuth(
  env: AuthEnv,
  requestOrigin?: string,
  executionCtx?: ExecutionContext,
) {
  // One Stripe client for both the billing plugin and the account-deletion
  // teardown (which cancels subscriptions before wiping data — ADR 0050).
  const stripeClient = new Stripe(
    env.STRIPE_SECRET_KEY ?? "sk_test_placeholder",
  );
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
    // Self-serve account deletion (ADR 0050, ticket #224 — the privacy pages
    // commit to it). Configuring `sendDeleteAccountVerification` routes EVERY
    // delete through an email-confirmation link: POST /delete-user only sends
    // the mail; the actual teardown runs in the /delete-user/callback the link
    // hits (which requires a live session), so both hooks below fire exactly
    // once, on confirmation. This is uniform across password AND Google-only
    // accounts (no per-type branching), and the callback's redirect to the
    // client-supplied callbackURL is a full navigation — the hardReset
    // singleton-teardown by construction (see auth-client.ts).
    user: {
      deleteUser: {
        enabled: true,
        // The confirmation email. Better Auth awaits this (no background-task
        // handler), and there's no enumeration channel to hide (the caller is
        // an authenticated session), so a plain await is correct — the "email
        // sent" response waits for the send. sendEmail never throws.
        sendDeleteAccountVerification: async ({ user, url }) => {
          await sendEmail(env, {
            to: user.email,
            ...deleteAccountEmail(url),
          });
        },
        // The safe-ordered teardown. Throwing ABORTS the D1 identity delete, so
        // any failure leaves the account fully intact and retryable — the worst
        // state (identity gone, Stripe still charging) can't be reached.
        beforeDelete: async (user) => {
          await deleteAccountData(
            {
              db: env.DB,
              stripe: stripeClient,
              userOutline: env.USER_OUTLINE,
              ownerUserId: env.OWNER_USER_ID,
            },
            user.id,
          );
        },
        // Best-effort PII scrub of the email-bearing side tables Better Auth's
        // cascade doesn't own. Runs after the identity is gone, so it never
        // throws (nothing left to roll back).
        afterDelete: async (user) => {
          await scrubUserPii({ db: env.DB }, user.email);
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
    // the signup UI wouldn't stop a direct POST to the endpoint.
    //
    // A signup is accepted when the supplied code is EITHER:
    //  (a) a per-email, single-use invite bound to this exact email (#251 —
    //      minted from the waitlist, redeemed here), OR
    //  (b) in the shared INVITE_CODES secret (kept as an admin/testing backdoor).
    // An unset INVITE_CODES and no matching per-email invite fails CLOSED: no
    // codes, no signups; sign-in is untouched.
    //
    // Redemption is split across before/after ON PURPOSE. `before` only
    // VALIDATES (a read) so a valid code isn't burned when account creation then
    // fails downstream (duplicate email, weak password). `after` stamps the code
    // redeemed — but only on a real success (the endpoint sets `returned` to an
    // APIError on failure), via a conditional UPDATE that can't double-burn. The
    // email uniqueness of the user table already stops two accounts sharing one
    // email-bound code, so this is belt-and-braces.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const supplied =
          typeof ctx.body?.inviteCode === "string"
            ? ctx.body.inviteCode.trim()
            : "";
        const email =
          typeof ctx.body?.email === "string"
            ? normalizeEmail(ctx.body.email)
            : "";
        // (a) A per-email single-use invite bound to this address.
        if (
          supplied &&
          email &&
          (await isRedeemableInvite(env, email, supplied))
        ) {
          return; // valid; the after-hook stamps it once the account exists
        }
        // (b) The shared INVITE_CODES backdoor.
        const codes = (env.INVITE_CODES ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        if (supplied && codes.includes(supplied)) return;
        throw new APIError("FORBIDDEN", {
          message:
            "Dotflowy is invite-only during alpha. Ask for an invite code, or join the waitlist.",
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        // Only burn the code on a genuine account creation. On failure the
        // endpoint's result — surfaced here as `ctx.context.returned` — is an
        // APIError, so we leave the invite unredeemed and reusable.
        if (ctx.context.returned instanceof APIError) return;
        const supplied =
          typeof ctx.body?.inviteCode === "string"
            ? ctx.body.inviteCode.trim()
            : "";
        const email =
          typeof ctx.body?.email === "string"
            ? normalizeEmail(ctx.body.email)
            : "";
        // No-op when `supplied` was the INVITE_CODES backdoor (no invites row).
        if (supplied && email) await redeemInvite(env, email, supplied);
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
        stripeClient,
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
